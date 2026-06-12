#!/usr/bin/env python3
"""Serve docs/ for local dev. Avoids os.getcwd() before chdir so it can run
from launchers whose initial working directory is inaccessible."""
import os

os.chdir('/Users/scottbrodbeck/Documents/GitHub/arlington-neighborhood-map/docs')

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler  # noqa: E402


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


PORT = int(os.environ.get('PORT', '8741'))
print(f'serving docs/ on http://127.0.0.1:{PORT}', flush=True)
ThreadingHTTPServer(('127.0.0.1', PORT), NoCacheHandler).serve_forever()
