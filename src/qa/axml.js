// Binary XML (AXML) as a tree, for the security scan: which intent-filters belong to which component,
// and whether a network-security-config rule sits inside <debug-overrides>. (../apk.js has a flat
// reader that is enough for the install preview.) All values come from an untrusted file.

const RES_STRING_POOL = 0x0001, RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102, RES_XML_END_ELEMENT = 0x0103, RES_XML_CDATA = 0x0104, RES_XML_RESOURCE_MAP = 0x0180;
export const TYPE_REFERENCE = 0x01, TYPE_STRING = 0x03, TYPE_INT_DEC = 0x10, TYPE_INT_HEX = 0x11, TYPE_INT_BOOLEAN = 0x12;

// android:* attribute ids, used only when an obfuscator stripped the attribute names.
const ATTR = {
  0x01010001: "label", 0x01010002: "icon", 0x01010003: "name", 0x01010006: "permission", 0x01010007: "readPermission",
  0x01010008: "writePermission", 0x01010009: "protectionLevel", 0x0101000b: "sharedUserId", 0x0101000e: "enabled",
  0x0101000f: "debuggable", 0x01010010: "exported", 0x01010012: "taskAffinity", 0x01010018: "authorities",
  0x0101001b: "grantUriPermissions", 0x0101001d: "launchMode", 0x01010027: "scheme", 0x01010028: "host",
  0x01010029: "port", 0x0101002a: "path", 0x0101002b: "pathPrefix", 0x0101002c: "pathPattern",
  0x0101020c: "minSdkVersion", 0x0101021b: "versionCode", 0x0101021c: "versionName", 0x01010270: "targetSdkVersion",
  0x01010272: "testOnly", 0x01010280: "allowBackup", 0x010104eb: "fullBackupContent", 0x010104ec: "usesCleartextTraffic",
  0x010104ee: "autoVerify", 0x01010527: "networkSecurityConfig",
};

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf16 = new TextDecoder("utf-16le", { fatal: false });

export function readStringPool(dv, off) {
  const count = dv.getUint32(off + 8, true);
  const flags = dv.getUint32(off + 16, true);
  const stringsStart = dv.getUint32(off + 20, true);
  const isUtf8 = (flags & 0x100) !== 0;
  const headerSize = dv.getUint16(off + 2, true);
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const get = (i) => {
    if (i < 0 || i >= count) return null;
    try {
      let p = off + stringsStart + dv.getUint32(off + headerSize + i * 4, true);
      if (isUtf8) {
        const n = bytes[p++]; if (n & 0x80) p++;
        let len = bytes[p++]; if (len & 0x80) len = ((len & 0x7f) << 8) | bytes[p++];
        return utf8.decode(bytes.subarray(p, p + len));
      }
      let len = dv.getUint16(p, true); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | dv.getUint16(p, true); p += 2; }
      return utf16.decode(bytes.subarray(p, p + len * 2));
    } catch { return null; }
  };
  return { get, count };
}

/** Binary XML -> root node { name, attrs: { name: value }, children: [], text? }. References are { ref: id }. */
export function parseXmlTree(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== RES_XML) throw new Error("Not a binary XML file");
  let strings = null, resMap = [];
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  let off = dv.getUint16(2, true);
  const end = Math.min(dv.getUint32(4, true), buf.byteLength);
  while (off + 8 <= end) {
    const type = dv.getUint16(off, true), headerSize = dv.getUint16(off + 2, true), size = dv.getUint32(off + 4, true);
    if (size < 8 || off + size > end) break;
    if (type === RES_STRING_POOL) strings = readStringPool(dv, off);
    else if (type === RES_XML_RESOURCE_MAP) {
      resMap = []; for (let p = off + headerSize; p + 4 <= off + size; p += 4) resMap.push(dv.getUint32(p, true));
    } else if (type === RES_XML_START_ELEMENT && strings) {
      const ext = off + headerSize;
      const name = strings.get(dv.getUint32(ext + 4, true)) || "";
      const attrStart = dv.getUint16(ext + 8, true), attrSize = dv.getUint16(ext + 10, true), attrCount = dv.getUint16(ext + 12, true);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        if (a + 20 > off + size) break;
        const nameIdx = dv.getUint32(a + 4, true);
        const rawIdx = dv.getUint32(a + 8, true);
        const dataType = dv.getUint8(a + 15), data = dv.getUint32(a + 16, true);
        const key = strings.get(nameIdx) || ATTR[resMap[nameIdx]] || `attr${nameIdx}`;
        let value;
        if (dataType === TYPE_STRING) value = strings.get(data);
        else if (dataType === TYPE_REFERENCE) value = { ref: data };
        else if (dataType === TYPE_INT_BOOLEAN) value = data !== 0;
        else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) value = data | 0;
        else value = rawIdx !== 0xffffffff ? strings.get(rawIdx) : data;
        attrs[key] = value;
      }
      const node = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (type === RES_XML_CDATA && strings) {
      // Text inside an element, e.g. <domain>example.com</domain>.
      const t = strings.get(dv.getUint32(off + headerSize, true));
      const cur = stack[stack.length - 1];
      if (t && cur !== root) cur.text = (cur.text || "") + t;
    } else if (type === RES_XML_END_ELEMENT) {
      if (stack.length > 1) stack.pop();
    }
    off += size;
  }
  return root;
}

/** All descendants named `name` (depth-first). */
export function findAll(node, name, out = []) {
  for (const c of node.children) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}
export const child = (node, name) => node?.children.find((c) => c.name === name) || null;

/**
 * Resolves a { ref } value with a parseArsc() table: to a string, boolean or number (default config
 * preferred). Plain values are returned as they are; unresolved references give null.
 */
export function resolveValue(table, value) {
  for (let hops = 0; hops < 8 && value && typeof value === "object" && "ref" in value; hops++) {
    if (!table) return null;
    const cands = table.lookup(value.ref);
    if (!cands.length) return null;
    const c = cands.find((x) => !x.language && x.density === 0) || cands.find((x) => !x.language) || cands[0];
    if (c.type === TYPE_STRING) return table.values.get(c.data);
    if (c.type === TYPE_INT_BOOLEAN) return c.data !== 0;
    if (c.type === TYPE_INT_DEC || c.type === TYPE_INT_HEX) return c.data | 0;
    if (c.type === TYPE_REFERENCE) { value = { ref: c.data }; continue; }
    return null;
  }
  return value && typeof value === "object" ? null : value;
}
