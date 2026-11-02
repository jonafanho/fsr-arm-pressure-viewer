"""Finder launcher: reuse this project's server, otherwise start and open it."""
import argparse
import http.client
import json
import threading
import webbrowser

import server


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--port', type=int, default=5182)
    args, _ = parser.parse_known_args()
    url = f'http://127.0.0.1:{args.port}/'
    connection = http.client.HTTPConnection('127.0.0.1', args.port, timeout=2)
    try:
        connection.request('GET', '/api/health')
        health = json.load(connection.getresponse())
    except (http.client.HTTPException, ValueError, OSError):
        health = None
    finally:
        connection.close()
    if health:
        if health.get('app') != 'fsr-single' or health.get('frontend') != str(server.FRONTEND):
            raise SystemExit('这个端口已有其他程序，请使用 --port 指定另一个端口。')
        print('前端已经运行，正在打开页面。原来的终端窗口需要保持开启。')
        webbrowser.open(url)
        return
    opener = threading.Timer(1.5, webbrowser.open, args=(url,))
    opener.daemon = True
    opener.start()
    try:
        server.main()
    finally:
        opener.cancel()


if __name__ == '__main__':
    main()
