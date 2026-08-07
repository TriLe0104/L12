/* TEMPORARY. Exercise the ORM + schema layer in-process, independent of the running
   server, to confirm what the app now reads and what FastAPI would serialise.     */
import { execFileSync } from "node:child_process";

const root = "C:\\Users\\tril\\Projects\\po-calendar\\backend";
const py = `
from app.db import SessionLocal
from app import models, schemas
db = SessionLocal()
a = db.query(models.Activity).order_by(models.Activity.created_at.desc()).first()
po = db.query(models.PurchaseOrder).order_by(models.PurchaseOrder.updated_at.desc()).first()
u = db.query(models.User).first()
print("Activity.created_at         :", repr(a.created_at))
print("PurchaseOrder.created_at    :", repr(po.created_at))
print("PurchaseOrder.updated_at    :", repr(po.updated_at))
print("PurchaseOrder.due_date      :", repr(po.due_date))
print("User.created_at             :", repr(u.created_at))
print("User.last_login_at          :", repr(u.last_login_at))
print("column type (activity)      :", models.Activity.__table__.c.created_at.type)
print("column type (due_date)      :", models.PurchaseOrder.__table__.c.due_date.type)
print()
print("as JSON, ActivityOut        :", schemas.ActivityOut.model_validate(a).model_dump_json())
print("as JSON, POOut.created_at   :", schemas.POOut.model_validate(po).model_dump_json(include={"created_at","updated_at","due_date"}))
print("as JSON, UserOut            :", schemas.UserOut.model_validate(u).model_dump_json(include={"created_at","last_login_at"}))
`;
process.stdout.write(
  execFileSync(`${root}\\.venv\\Scripts\\python.exe`, ["-c", py], { encoding: "utf8", cwd: root }),
);
