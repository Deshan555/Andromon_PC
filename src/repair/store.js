// Andromon — Repair: the shop's jobs, kept on this computer only (the browser engine's IndexedDB,
// in Andromon's own data folder). Two stores: "jobs" (one record per repair job) and "files"
// (photos and other files attached to a job, as Blobs). Nothing is sent anywhere.
//
// A job: { id, number: "R-0001", created, updated, status, customer: { name, phone, email },
//          device: { model, serial, imei, color, lockNote }, fault, quote, deposit, notes,
//          history: [{ at, text }], reports: { checkin, checkout }, tests: { at, results }, files: [id] }

const DB = "andromon-repair", VERSION = 1;
export const STATUSES = [
  ["received", "Received"], ["diagnosing", "Diagnosing"], ["waiting", "Waiting for parts"], ["repairing", "Repairing"],
  ["ready", "Ready to collect"], ["collected", "Collected"], ["cancelled", "Cancelled"],
];
export const statusName = (s) => STATUSES.find(([k]) => k === s)?.[1] || s;

let dbp = null;
function db() {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("jobs")) d.createObjectStore("jobs", { keyPath: "id" }).createIndex("updated", "updated");
      if (!d.objectStoreNames.contains("files")) d.createObjectStore("files", { keyPath: "id" }).createIndex("jobId", "jobId");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { dbp = null; reject(r.error || new Error("The repair jobs couldn't be opened")); };
  }));
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
async function tx(store, mode, fn) {
  const t = (await db()).transaction(store, mode);
  const out = await fn(t.objectStore(store));
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error("Cancelled")); });
  return out;
}
const newId = () => crypto.randomUUID();

export async function listJobs() {
  const all = await tx("jobs", "readonly", (s) => req(s.getAll()));
  return all.sort((a, b) => b.updated - a.updated);
}
export const getJob = (id) => tx("jobs", "readonly", (s) => req(s.get(id)));

export async function newJob(fields = {}) {
  const jobs = await listJobs();
  const next = jobs.reduce((n, j) => Math.max(n, Number(String(j.number).replace(/\D/g, "")) || 0), 0) + 1;
  const now = Date.now();
  const job = {
    id: newId(), number: `R-${String(next).padStart(4, "0")}`, created: now, updated: now, status: "received",
    customer: { name: "", phone: "", email: "" }, device: { model: "", serial: "", imei: "", color: "", lockNote: "" },
    fault: "", quote: "", deposit: "", notes: "", history: [{ at: now, text: "Job opened" }], reports: {}, tests: null, files: [],
    ...fields,
  };
  await tx("jobs", "readwrite", (s) => req(s.put(job)));
  return job;
}
/** Saves changes to a job. `note` (optional) goes in its history. */
export async function saveJob(job, note = "") {
  job.updated = Date.now();
  if (note) job.history = [...(job.history || []), { at: job.updated, text: note }];
  await tx("jobs", "readwrite", (s) => req(s.put(job)));
  return job;
}
export async function deleteJob(job) {
  for (const id of job.files || []) await tx("files", "readwrite", (s) => req(s.delete(id))).catch(() => {});
  await tx("jobs", "readwrite", (s) => req(s.delete(job.id)));
}

export async function addFile(job, blob, name, kind = "photo") {
  const f = { id: newId(), jobId: job.id, name: String(name || "file"), kind, type: blob.type || "", size: blob.size, at: Date.now(), blob };
  await tx("files", "readwrite", (s) => req(s.put(f)));
  job.files = [...(job.files || []), f.id];
  await saveJob(job, `${kind === "photo" ? "Photo" : "File"} added: ${f.name}`);
  return f;
}
export const getFile = (id) => tx("files", "readonly", (s) => req(s.get(id)));
export async function removeFile(job, id) {
  await tx("files", "readwrite", (s) => req(s.delete(id)));
  job.files = (job.files || []).filter((x) => x !== id);
  await saveJob(job, "File removed");
}
