import subprocess

def run(cmd):
    return subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.STDOUT, errors="replace")

print("=== netstat 8000/8001 ===")
hs = run("netstat -ano")
for line in ns.splitlines():
    if ":8000" in line or ":8001" in line:
        print(line)

pids_8000=set(); pids_8001=set()
for line in ns.splitlines():
    parts=line.split()
    if len(parts)>=5 and "LISTENING" in parts:
        if ":8000" in parts[1]: pids_8000.add(int(parts[-1]))
        if ":8001" in parts[1]: pids_8001.add(int(parts[-1]))
print("8000 PIDs:", sorted(pids_8000))
print("8001 PIDs:", sorted(pids_8001))

print("=== tasklist ===")
for pid in sorted(pids_8000|pids_8001):
    try:
        print(run("tasklist /FI '"PID eq %d"' /FO LIST" % pid))
    except Exception as e:
        print(pid, e)

print("=== wmic python ===")
try:
    print(run("wmic process where name='python.exe' get ProcessId,CommandLine /FORMAT:LIST"))
except Exception as e:
    print("wmic failed", e)
