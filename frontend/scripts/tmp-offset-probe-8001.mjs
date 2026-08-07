/* TEMPORARY. Ten independent requests: does every datetime the API emits carry an offset? */
const API = "http://127.0.0.1:8001";
const res = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "trile0104@gmail.com", password: "tvm-temp-2026" }),
});
const { access_token: T } = await res.json();
const get = async (p) =>
  (await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${T}` } })).json();

const orders = await get("/api/purchase-orders");
const po = orders.find((o) => o.job_no === "J-42");
for (let i = 0; i < 2; i++) {
  const one = await get(`/api/purchase-orders/${po.id}`);
  const trail = await get(`/api/purchase-orders/${po.id}/activity`);
  const users = await get("/api/users");
  const aware = (s) => (s == null ? "n/a" : /(Z|[+-]\d\d:\d\d)$/.test(s) ? "aware" : `NAIVE(${s})`);
  console.log(
    `${i}: created=${aware(one.created_at)} updated=${aware(one.updated_at)} ` +
      `trail=${aware(trail[0]?.created_at)} last_modified=${aware(one.last_modified?.at)} ` +
      `user.created=${aware(users[0].created_at)} due=${one.due_date}`,
  );
}
