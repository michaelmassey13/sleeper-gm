# Local dev server that tells the browser not to cache, so edits show up on a normal refresh.
# Usage: python3 serve.py [port]
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
print(f"Serving on http://localhost:{port}")
ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
