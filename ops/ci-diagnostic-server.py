#!/usr/bin/env python3
"""ci-diagnostic-server.py: fallback HTTP server on :80 when the app fails to deploy.

Serves the build log tail, docker state, container logs, and disk usage as a
single HTML page, so a failed first-boot is diagnosable with a plain curl.
Started by ci-deploy; killed by ci-deploy before every rebuild.
"""
import http.server
import subprocess
import os
import html

BUILD_LOG = '/var/log/ci-build.log'


def run(cmd):
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        out = (p.stdout or '') + (p.stderr or '')
        return out.strip()[:9000] or '(empty)'
    except Exception as e:  # noqa: BLE001
        return f'(error: {e})'


def tail(path, n=12000):
    try:
        with open(path, 'r', errors='replace') as f:
            data = f.read()
        return data[-n:] or '(empty)'
    except Exception as e:  # noqa: BLE001
        return f'(unreadable: {e})'


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        sections = [
            ('Build log (tail)', tail(BUILD_LOG)),
            ('docker ps -a', run('docker ps -a')),
            ('docker images (central-intelligence)', run('docker images | grep -i central || docker images | head -5')),
            ('ci-backend logs (tail 60)', run('docker logs --tail 60 ci-backend 2>&1')),
            ('disk usage', run('df -h / /var/lib/docker 2>/dev/null')),
            ('memory', run('free -m | head -3')),
        ]
        parts = ['<html><head><title>Central Intelligence - deploy diagnostic</title></head>'
                 '<body style="font-family:monospace;background:#050B16;color:#7FCEF0">'
                 '<h1>Central Intelligence - deployment diagnostic</h1>'
                 '<p>The app container did not become healthy. '
                 'This page is served by the fallback diagnostic server.</p>']
        for title, body in sections:
            parts.append(f'<h2>{html.escape(title)}</h2><pre>{html.escape(body)}</pre>')
        parts.append('</body></html>')
        data = ''.join(parts).encode()
        self.send_response(503)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # silence request logs
        pass


if __name__ == '__main__':
    http.server.HTTPServer(('0.0.0.0', 80), Handler).serve_forever()
