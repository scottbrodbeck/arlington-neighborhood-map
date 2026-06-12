#!/usr/bin/env python3
"""Build ARLnow's canonical Arlington neighborhood polygons.

Starts from Arlington County's Civic Association polygons and applies the
hand-annotated changes from the newsroom's printed wall map (IMG_8281.jpeg):

  1. Rename "Arlington - East Falls Church"  -> "East Falls Church"
  2. Rename "John M Langston"                -> "Hall's Hill / High View Park"
  3. Split  "Ballston - Virginia Square"     -> "Ballston" / "Virginia Square"
     along N. Quincy St
  4. Split  "Clarendon - Courthouse"         -> "Clarendon" / "Courthouse"
     along N. Barton St
  5. "Rosslyn" = North Rosslyn + the part of Radnor/Ft.Myer Heights north of
     14th St N ("North" was struck through on the map; the drawn loop takes in
     the Rosslyn high-rise district but leaves the Ft. Myer Heights bluff)
  6. Carve "Pentagon City" out of Aurora Highlands (I-395 / S. Joyce St /
     15th St S -> S. Hayes St -> 18th St S / S. Eads St)
  7. New "Country Club Hills" filling the unassigned hole around
     Washington Golf & Country Club
  8. New "Potomac Yard (National Landing)" filling the unassigned strip
     between Crystal City, US-1, the airport and the Alexandria line,
     including the Crystal Dr/Potomac Ave hotel block north of it
  9. New "Joint Base Myer-Henderson Hall" from the OSM base boundary
     intersected with unassigned land (cemetery stays unassigned)
 10. Gap fills merged into neighbors: Brandon Village block -> Buckingham;
     Memorial Baptist Church block + 36th/Glebe triangle -> Old Glebe;
     the block north of Claremont -> Claremont; the area east of
     Shirlington up to I-395 -> Shirlington

Street geometry comes from OpenStreetMap extracts in data/osm/.
Output: arlington_neighborhoods.geojson (same property schema as the source).
"""
import json
import os
import sys

from shapely.geometry import LineString, MultiLineString, Point, Polygon, MultiPolygon, mapping, shape
from shapely.ops import linemerge, polygonize, split, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'Civic_Association_Polygons.geojson')
OSM = os.path.join(ROOT, 'data', 'osm')
OUT = os.path.join(ROOT, 'arlington_neighborhoods.geojson')

# ---------------------------------------------------------------- load inputs
with open(SRC) as f:
    src = json.load(f)
features = src['features']
by_name = {ft['properties']['CIVIC']: ft for ft in features}

streets = json.load(open(os.path.join(OSM, 'streets.json')))['elements']


def poly_of(ft):
    g = shape(ft['geometry'])
    if g.geom_type == 'MultiPolygon':
        assert len(g.geoms) == 1, ft['properties']['CIVIC']
        return g.geoms[0]
    return g


# ------------------------------------------------------------ street helpers
def street_segments(name, lat_range=None, lon_range=None):
    """All OSM ways with this exact name, optionally midpoint-filtered."""
    segs = []
    for w in streets:
        if w.get('tags', {}).get('name', '').lower() != name.lower():
            continue
        if 'geometry' not in w:
            continue
        pts = [(p['lon'], p['lat']) for p in w['geometry']]
        mid = pts[len(pts) // 2]
        if lat_range and not (lat_range[0] <= mid[1] <= lat_range[1]):
            continue
        if lon_range and not (lon_range[0] <= mid[0] <= lon_range[1]):
            continue
        segs.append(pts)
    return segs


def chain(segs, axis):
    """Merge street segments into one polyline ordered along axis(0=lon,1=lat),
    bridging small gaps at intersections."""
    merged = linemerge(MultiLineString(segs))
    parts = list(merged.geoms) if merged.geom_type == 'MultiLineString' else [merged]
    parts.sort(key=lambda l: min(p[axis] for p in l.coords))
    coords = []
    for part in parts:
        c = list(part.coords)
        if c[0][axis] > c[-1][axis]:
            c.reverse()
        if coords:
            # avoid doubling back: drop points behind current head
            c = [p for p in c if p[axis] >= coords[-1][axis] - 1e-9]
        coords.extend(c)
    return coords


def extend(coords, axis, lo, hi):
    """Extend a polyline straight out along axis to lo/hi so it fully crosses
    the target polygon."""
    first, last = coords[0], coords[-1]
    pre = (first[0], lo) if axis == 1 else (lo, first[1])
    post = (last[0], hi) if axis == 1 else (hi, last[1])
    return LineString([pre] + coords + [post])


def cut(poly, line, probe_a, probe_b):
    """Split poly with line; return (piece containing probe_a, piece containing
    probe_b). Slivers attach to whichever side they touch most."""
    pieces = [g for g in split(poly, line).geoms if g.geom_type == 'Polygon']
    a_parts, b_parts = [], []
    pa, pb = Point(probe_a), Point(probe_b)
    main_a = max(pieces, key=lambda g: g.contains(pa) * g.area)
    main_b = max(pieces, key=lambda g: g.contains(pb) * g.area)
    assert main_a.contains(pa) and main_b.contains(pb), 'probe points missed'
    assert main_a is not main_b
    for g in pieces:
        if g is main_a or g is main_b:
            continue
        # attach leftover slivers to the side they share the longest border with
        la = g.intersection(main_a).length
        lb = g.intersection(main_b).length
        (a_parts if la >= lb else b_parts).append(g)
    side_a = unary_union([main_a] + a_parts)
    side_b = unary_union([main_b] + b_parts)
    assert abs(side_a.area + side_b.area - poly.area) < 1e-12
    return side_a, side_b


# ---------------------------------------------------------- feature plumbing
next_objectid = max(ft['properties']['OBJECTID'] for ft in features) + 1
next_gisid = max(ft['properties']['GIS_ID'] for ft in features) + 1


def set_geometry(ft, geom):
    if geom.geom_type == 'Polygon':
        geom = MultiPolygon([geom])
    ft['geometry'] = mapping(geom)
    ft['properties']['SHAPE_Length'] = geom.length
    ft['properties']['SHAPE_Area'] = geom.area


def rename(ft, new_name):
    ft['properties']['CIVIC'] = new_name
    ft['properties']['LABEL'] = new_name
    ft['properties']['Pdf'] = new_name.replace("'", '').replace('/', '_').replace('.', '').replace(' ', '_')


def new_feature(name, geom, color):
    global next_objectid, next_gisid
    ft = {
        'type': 'Feature',
        'properties': {
            'OBJECTID': next_objectid,
            'CIVIC': name,
            'COLOR': color,
            'LABEL': name,
            'GIS_ID': next_gisid,
            'Pdf': name.replace("'", '').replace('/', '_').replace('.', '').replace(' ', '_').replace('(', '').replace(')', ''),
            'SHAPE_Length': 0.0,
            'SHAPE_Area': 0.0,
        },
        'geometry': None,
    }
    next_objectid += 1
    next_gisid += 1
    set_geometry(ft, geom)
    return ft


original_union = unary_union([shape(ft['geometry']) for ft in features])

# ------------------------------------------------------------------ 1 & 2
rename(by_name['Arlington - East Falls Church'], 'East Falls Church')
rename(by_name['John M Langston'], "Hall's Hill / High View Park")

# ------------------------------ 2b. Cherry Valley Nature Area -> Cherrydale
cv_ft = by_name.pop('Cherry Valley Nature Area')
cherry_rep = shape(cv_ft['geometry']).representative_point().coords[0]
set_geometry(by_name['Cherrydale'],
             unary_union([shape(cv_ft['geometry']),
                          shape(by_name['Cherrydale']['geometry'])]))
features.remove(cv_ft)

# ------------------------------------------------- 3. Ballston / Virginia Sq
bvs = poly_of(by_name['Ballston - Virginia Square'])
quincy = extend(chain(street_segments('North Quincy Street',
                                      lat_range=(38.874, 38.896)), axis=1),
                axis=1, lo=38.873, hi=38.897)
ballston, va_square = cut(bvs, quincy,
                          probe_a=(-77.1118, 38.8821),   # Ballston metro
                          probe_b=(-77.1035, 38.8831))   # Virginia Sq metro
ft = by_name['Ballston - Virginia Square']
rename(ft, 'Ballston')
set_geometry(ft, ballston)
vsq_ft = new_feature('Virginia Square', va_square, color=4)
features.insert(features.index(ft) + 1, vsq_ft)

# 3b. The Wilson Blvd / N. Quincy St / N. Glebe Rd triangle west of Quincy
# (part of Ashton Heights CA) reads as Ballston per the newsroom (round 4).
# The same Quincy cut line works: Quincy dead-ends into Glebe Rd at the
# triangle's southern vertex, and Glebe is already the CA boundary.
ash_w, ash_e = cut(poly_of(by_name['Ashton Heights']), quincy,
                   probe_a=(-77.1095, 38.8775),   # the triangle
                   probe_b=(-77.1015, 38.8780))   # Ashton Heights proper
set_geometry(by_name['Ashton Heights'], ash_e)
set_geometry(ft, unary_union([shape(ft['geometry']), ash_w]))

# ------------------------------------------------ 4. Clarendon / Courthouse
cc = poly_of(by_name['Clarendon - Courthouse'])
barton = extend(chain(street_segments('North Barton Street',
                                      lat_range=(38.878, 38.896)), axis=1),
                axis=1, lo=38.880, hi=38.897)
clarendon, courthouse = cut(cc, barton,
                            probe_a=(-77.0955, 38.8868),  # Clarendon metro
                            probe_b=(-77.0852, 38.8907))  # courthouse complex
ft = by_name['Clarendon - Courthouse']
rename(ft, 'Clarendon')
set_geometry(ft, clarendon)
ch_ft = new_feature('Courthouse', courthouse, color=5)
features.insert(features.index(ft) + 1, ch_ft)

# ------------------------------------------------------------- 5. Rosslyn
radnor = poly_of(by_name['Radnor/Ft.Myer Heights'])
fourteenth = extend(chain(street_segments('14th Street North',
                                          lon_range=(-77.087, -77.069)), axis=0),
                    axis=0, lo=-77.087, hi=-77.066)
radnor_n, radnor_s = cut(radnor, fourteenth,
                         probe_a=(-77.0750, 38.8930),   # Rosslyn CBD south
                         probe_b=(-77.0790, 38.8880))   # Ft. Myer Heights bluff
rosslyn_geom = unary_union([poly_of(by_name['North Rosslyn']), radnor_n])
ft = by_name['North Rosslyn']
rename(ft, 'Rosslyn')
set_geometry(ft, rosslyn_geom)
set_geometry(by_name['Radnor/Ft.Myer Heights'], radnor_s)

# ------------------------------------------------------- 6. Pentagon City
ah = poly_of(by_name['Aurora Highlands'])
seg_15 = chain(street_segments('15th Street South', lon_range=(-77.0666, -77.0572)), axis=0)
seg_hayes = chain(street_segments('South Hayes Street', lat_range=(38.8567, 38.8612)), axis=1)
seg_18 = chain(street_segments('18th Street South', lon_range=(-77.0580, -77.0488)), axis=0)
seg_hayes.sort(key=lambda p: -p[1])  # north -> south to connect 15th to 18th
pc_coords = seg_15 + seg_hayes + seg_18
pc_line = LineString([(-77.0680, seg_15[0][1])] + pc_coords + [(-77.0460, seg_18[-1][1])])
pentagon_city, aurora = cut(ah, pc_line,
                            probe_a=(-77.0599, 38.8627),   # Fashion Centre mall
                            probe_b=(-77.0590, 38.8520))   # Aurora Highlands core
ft = by_name['Aurora Highlands']
set_geometry(ft, aurora)
pc_ft = new_feature('Pentagon City', pentagon_city, color=3)
features.insert(features.index(ft), pc_ft)

# ------------------------------------------------- 7. Country Club Hills
holes = []
for part in (original_union.geoms if original_union.geom_type == 'MultiPolygon' else [original_union]):
    holes.extend(Polygon(r) for r in part.interiors)
cch = max((h for h in holes), key=lambda h: h.area)
assert cch.contains(Point(-77.1259, 38.9103)), 'expected Washington Golf & CC hole'
features.append(new_feature('Country Club Hills', cch, color=2))

# ------------------------- 8. Potomac Yard (National Landing) gap fill
cty = json.load(open(os.path.join(OSM, 'county2.json')))
rel = [e for e in cty['elements'] if e['type'] == 'relation'][0]
county = max(polygonize(linemerge([
    LineString([(p['lon'], p['lat']) for p in m['geometry']])
    for m in rel['members']
    if m['type'] == 'way' and 'geometry' in m and m.get('role', 'outer') == 'outer'
])), key=lambda p: p.area)

dca_raw = json.load(open(os.path.join(OSM, 'dca.json')))
drel = [e for e in dca_raw['elements'] if e['type'] == 'relation'][0]
dca = max(polygonize(linemerge([
    LineString([(p['lon'], p['lat']) for p in m['geometry']])
    for m in drel['members'] if m['type'] == 'way' and 'geometry' in m and m.get('role') == 'outer'
])), key=lambda p: p.area)

gap = county.difference(original_union)
gap_parts = sorted((gap.geoms if gap.geom_type == 'MultiPolygon' else [gap]),
                   key=lambda p: -p.area)
big = gap_parts[0]


def gap_part_at(lonlat):
    pt = Point(lonlat)
    return next(p for p in gap_parts if p.contains(pt))


clipbox = Polygon([(-77.0585, 38.8330), (-77.0395, 38.8330),
                   (-77.0395, 38.8462), (-77.0585, 38.8462)])
# hotel block north of 33rd (Crystal Dr / Potomac Ave, east of Crystal City CA).
# NOTE: the OSM aerodrome polygon over-extends north of the actual airfield and
# covers this block, so the airport is only subtracted south of the 33rd St line.
north_box = Polygon([(-77.0530, 38.8460), (-77.0438, 38.8460),
                     (-77.0438, 38.8516), (-77.0530, 38.8516)])
south_half = Polygon([(-77.06, 38.82), (-77.03, 38.82),
                      (-77.03, 38.8462), (-77.06, 38.8462)])
py = big.intersection(clipbox.union(north_box)).difference(dca.intersection(south_half))
py_parts = sorted((py.geoms if py.geom_type == 'MultiPolygon' else [py]), key=lambda p: -p.area)
py_main = py_parts[0]
# keep secondary fragments only if they're meaningful and touch the main piece
for p in py_parts[1:]:
    if p.area > 1e-8 and p.distance(py_main) < 1e-6:
        py_main = unary_union([py_main, p])

# Potomac Yard stays west of the GW Parkway (drops the airport W Entrance
# block and the shoreline strip south of the airfield)
gwp = extend(chain(street_segments('George Washington Memorial Parkway',
                                   lat_range=(38.832, 38.856),
                                   lon_range=(-77.052, -77.036)), axis=1),
             axis=1, lo=38.830, hi=38.858)
west_pieces = []
for piece in split(py_main, gwp).geoms:
    if piece.geom_type != 'Polygon' or piece.area < 1e-8:
        continue
    rp = piece.representative_point()
    if rp.x < gwp.interpolate(gwp.project(rp)).x:
        west_pieces.append(piece)
py_clipped = unary_union(west_pieces)
assert py_clipped.geom_type == 'Polygon' and py_clipped.area < py_main.area
py_east_removed = py_main.difference(py_clipped)
py_main = py_clipped
features.append(new_feature('Potomac Yard (National Landing)', py_main, color=1))

# --------------------------------- 9. Joint Base Myer-Henderson Hall (new)
mil = json.load(open(os.path.join(OSM, 'military.json')))
jb_way = next(e for e in mil['elements'] if e['id'] == 60126133)
jb = Polygon([(p['lon'], p['lat']) for p in jb_way['geometry']]).intersection(big)
assert jb.geom_type == 'Polygon' and jb.area > 1e-4
features.append(new_feature('Joint Base Myer-Henderson Hall', jb, color=5))

# ------------------------------------------ 10. gap fills merged into CAs
additions = [cch, py_main, jb]


def absorb(ca_name, piece):
    ft = by_name[ca_name]
    merged = unary_union([shape(ft['geometry']), piece])
    set_geometry(ft, merged)
    additions.append(piece)


absorb('Buckingham', gap_part_at((-77.1148, 38.8750)))      # Brandon Village
absorb('Old Glebe', gap_part_at((-77.1349, 38.9140)))       # Memorial Baptist Church + 36th/Glebe triangle
absorb('Claremont', gap_part_at((-77.1039, 38.8486)))       # block north of Claremont

# east of Shirlington up to (but not across) I-395
i395_raw = json.load(open(os.path.join(OSM, 'i395.json')))
i395_segs = [[(p['lon'], p['lat']) for p in w['geometry']]
             for w in i395_raw['elements']
             if w.get('tags', {}).get('name') == 'Henry G. Shirley Memorial Highway'
             and 'geometry' in w]
i395 = extend(chain(i395_segs, axis=1), axis=1, lo=38.8300, hi=38.8560)
sh_box = Polygon([(-77.0865, 38.8370), (-77.0750, 38.8370),
                  (-77.0750, 38.8490), (-77.0865, 38.8490)])
sh_area = big.intersection(sh_box)
shirl = shape(by_name['Shirlington']['geometry'])
west = []
for p in (sh_area.geoms if sh_area.geom_type == 'MultiPolygon' else [sh_area]):
    for piece in split(p, i395).geoms:
        if piece.geom_type == 'Polygon' and piece.representative_point().x < \
                i395.interpolate(i395.project(piece.representative_point())).x:
            if piece.distance(shirl) < 1e-6 and piece.area > 1e-8:
                west.append(piece)
absorb('Shirlington', unary_union(west))

# -------------------------------------------------------------- validation
print('--- validation ---')
final_geoms = {ft['properties']['CIVIC']: shape(ft['geometry']) for ft in features}
assert len(final_geoms) == len(features), 'duplicate names'
bad = [n for n, g in final_geoms.items() if not g.is_valid]
assert not bad, f'invalid geometries: {bad}'

new_union = unary_union(list(final_geoms.values()))
lost = original_union.difference(new_union)
print(f'area lost vs original: {lost.area:.2e} (expect ~0)')
added = new_union.difference(original_union)
expect_added = unary_union(additions)
print(f'area added: {added.area:.2e}; expected: {expect_added.area:.2e}')
assert abs(added.area - expect_added.area) < 1e-9

names = sorted(final_geoms)
worst = 0.0
for i, a in enumerate(names):
    for b in names[i + 1:]:
        if final_geoms[a].intersects(final_geoms[b]):
            ov = final_geoms[a].intersection(final_geoms[b]).area
            worst = max(worst, ov)
            if ov > 1e-10:
                print(f'OVERLAP {a} / {b}: {ov:.2e}')
print(f'worst pairwise overlap: {worst:.2e}')

for label, pt, want in [
    ('Ballston metro', (-77.1118, 38.8821), 'Ballston'),
    ('Quincy/Glebe triangle', (-77.1095, 38.8775), 'Ballston'),
    ('Ashton Heights core', (-77.1015, 38.8780), 'Ashton Heights'),
    ('Central Library', (-77.1068, 38.8866), 'Virginia Square'),
    ('Clarendon metro', (-77.0955, 38.8868), 'Clarendon'),
    ('Courthouse complex', (-77.0852, 38.8907), 'Courthouse'),
    ('Rosslyn metro', (-77.0717, 38.8959), 'Rosslyn'),
    ('Ft Myer Hts bluff', (-77.0790, 38.8880), 'Radnor/Ft.Myer Heights'),
    ('Fashion Centre mall', (-77.0599, 38.8627), 'Pentagon City'),
    ('Aurora Highlands core', (-77.0590, 38.8520), 'Aurora Highlands'),
    ('Wash Golf & CC', (-77.1259, 38.9103), 'Country Club Hills'),
    ('Eclipse on Center Park', (-77.0508, 38.8427), 'Potomac Yard (National Landing)'),
    ('Renaissance Capital View', (-77.0492, 38.8474), 'Potomac Yard (National Landing)'),
    ('Hotel-block triangle', (-77.0514, 38.8479), 'Potomac Yard (National Landing)'),
    ('Met Park / HQ2', (-77.0520, 38.8575), 'Crystal City'),
    ('Ft Myer (Whipple Field)', (-77.0795, 38.8830), 'Joint Base Myer-Henderson Hall'),
    ('Henderson Hall', (-77.0775, 38.8690), 'Joint Base Myer-Henderson Hall'),
    ('Brandon Village', (-77.1148, 38.8750), 'Buckingham'),
    ('Memorial Baptist Church', (-77.1349, 38.9140), 'Old Glebe'),
    ('North-of-Claremont block', (-77.1039, 38.8486), 'Claremont'),
    ('East-of-Shirlington area', (-77.0824, 38.8437), 'Shirlington'),
    ('Cherry Valley Nature Area', cherry_rep, 'Cherrydale'),
    ('Tuckahoe Elem.', (-77.1551, 38.8950), 'East Falls Church'),
    ("Hall's Hill rep. point",
     next(p for p in [final_geoms["Hall's Hill / High View Park"].representative_point()]
          ).coords[0], "Hall's Hill / High View Park"),
]:
    hits = [n for n, g in final_geoms.items() if g.contains(Point(pt))]
    ok = hits == [want]
    print(f'{"OK " if ok else "FAIL"} {label:28s} -> {hits}')
    assert ok, label

# east-of-parkway land removed from Potomac Yard belongs to nothing
east_rep = py_east_removed.representative_point()
assert not any(g.contains(east_rep) for g in final_geoms.values())
print(f'OK  east-of-GWP area ({py_east_removed.area:.1e}) unassigned')

# -------------------------------------------------------------------- write
out = dict(src)
out['name'] = 'ARLnow_Neighborhoods'
out['features'] = features
with open(OUT, 'w') as f:
    json.dump(out, f)
print(f'\nwrote {OUT} with {len(features)} features')

# ------------------------------------------------------- web app data export
# Slim copy for the docs/ site: only name+color, coords rounded to 6 decimals
# (~11 cm), plus one label point per neighborhood placed with
# representative_point() so it always falls inside the polygon.
DOCS = os.path.join(ROOT, 'docs')
os.makedirs(DOCS, exist_ok=True)


def round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], float):
            return [round(v, 6) for v in obj]
        return [round_coords(v) for v in obj]
    return obj


web_feats, label_feats = [], []
for ft in features:
    name = ft['properties']['CIVIC']
    geom = dict(ft['geometry'])
    geom['coordinates'] = round_coords(geom['coordinates'])
    web_feats.append({'type': 'Feature',
                      'properties': {'name': name, 'color': ft['properties']['COLOR']},
                      'geometry': geom})
    rp = shape(ft['geometry']).representative_point()
    label_feats.append({'type': 'Feature',
                        'properties': {'name': name},
                        'geometry': {'type': 'Point',
                                     'coordinates': [round(rp.x, 6), round(rp.y, 6)]}})

for fname, feats in (('neighborhoods.json', web_feats), ('labels.json', label_feats)):
    path = os.path.join(DOCS, fname)
    with open(path, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f,
                  separators=(',', ':'))
    print(f'wrote {path} ({os.path.getsize(path):,} bytes)')

# Simplified county outline so the app can tell "in Arlington but unassigned"
# (Pentagon, cemetery, airport...) apart from "outside the county" exactly,
# rather than with a bounding box that overlaps DC and Alexandria.
county_ring = [[round(x, 5), round(y, 5)]
               for x, y in county.simplify(0.0004).exterior.coords]
path = os.path.join(DOCS, 'county.json')
with open(path, 'w') as f:
    json.dump({'ring': county_ring}, f, separators=(',', ':'))
print(f'wrote {path} ({os.path.getsize(path):,} bytes)')
