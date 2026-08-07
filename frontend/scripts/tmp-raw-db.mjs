/* TEMPORARY. Read the sqlite file directly, bypassing the ORM, to confirm what is
   actually stored in the datetime columns and that due_date is date-only.        */
import { execFileSync } from "node:child_process";

const root = "C:\\Users\\tril\\Projects\\po-calendar\\backend";
const py = `
import sqlite3, datetime, glob, os
path = glob.glob(os.path.join(r"${root}", "*.db")) + glob.glob(os.path.join(r"${root}", "**", "*.db"), recursive=True)
path = [p for p in path if "venv" not in p][0]
print("db file:", path)
c = sqlite3.connect(path)
print("python utcnow    :", datetime.datetime.now(datetime.timezone.utc).isoformat())
print("python localnow  :", datetime.datetime.now().isoformat())
for sql, label in [
    ("select created_at from activity order by created_at desc limit 3", "activity.created_at (newest first)"),
    ("select created_at, updated_at from purchase_orders order by updated_at desc limit 2", "purchase_orders created/updated"),
    ("select typeof(due_date), due_date from purchase_orders limit 3", "purchase_orders.due_date (type, value)"),
    ("select created_at, last_login_at from users", "users created/last_login"),
]:
    print("--", label)
    for row in c.execute(sql):
        print("   ", row)
`;
process.stdout.write(
  execFileSync(`${root}\\.venv\\Scripts\\python.exe`, ["-c", py], { encoding: "utf8" }),
);
