"""Read-only discovery check against the installed Codex runtime; no model turn."""
import json
import os
import select
import subprocess
import time


def main():
    process = subprocess.Popen(
        ["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True,
    )

    def call(identifier, method, params):
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": identifier,
                                       "method": method, "params": params}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if not select.select([process.stdout], [], [], 1)[0]:
                continue
            line = process.stdout.readline()
            if not line:
                raise RuntimeError("Codex exited during discovery")
            reply = json.loads(line)
            if reply.get("id") == identifier:
                if "error" in reply:
                    raise RuntimeError(reply["error"])
                return reply["result"]
        raise TimeoutError(method)

    try:
        call(1, "initialize", {"clientInfo": {"name": "componion-check", "version": "1"},
                               "capabilities": {"experimentalApi": True}})
        process.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n')
        process.stdin.flush()
        hooks = call(2, "hooks/list", {"cwds": [os.getcwd()]})
        found = [h for entry in hooks["data"] for h in entry["hooks"]
                 if h.get("pluginId") == "componion@personal"]
        assert len(found) == 5, f"Expected 5 hooks, found {len(found)}"
        print("Componion: 5 hooks discovered; trust=" + ",".join(sorted({h["trustStatus"] for h in found})))
        status = call(3, "mcpServerStatus/list", {"limit": 100})
        servers = {s["name"]: s for s in status["data"]}
        for name, expected in [("componion", {"decompress", "search_context", "index_context", "status", "compact_context", "fold_context", "compaction_status"}),
                               ("kern", {"kern"})]:
            server = servers[name]
            assert not server.get("toolsError"), server.get("toolsError")
            assert expected <= server["tools"].keys(), server["tools"].keys()
            print(f"{name}: Codex loaded {len(server['tools'])} tools")
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == "__main__":
    main()
