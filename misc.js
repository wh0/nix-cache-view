async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} status ${res.status} not ok`);
  return res;
}

async function fetchOkText(url) {
  const res = await fetchOk(url);
  return await res.text();
}

async function fetchOkBuf(url) {
  const res = await fetchOk(url);
  return await res.arrayBuffer();
}

const XZ_EMBEDDED_URL = 'https://cdn.glitch.global/48b707a2-e71d-4252-87d2-1e0ae3bbd38b/xz-embedded.wasm?v=1662960924981';

async function xzDecompress(inBuf, outSize) {
  console.log('fetch + instantiateStreaming');
  const inst = (await WebAssembly.instantiateStreaming(fetch(XZ_EMBEDDED_URL))).instance;
  console.log('xz_crc32_init');
  inst.exports.xz_crc32_init();
  console.log('xz_crc64_init');
  inst.exports.xz_crc64_init();
  const decP = inst.exports.xz_dec_init(0 /* XZ_SINGLE */, 64 * 1024 * 1024);
  if (!decP) throw new Error('xz_dec_init null');
  const bufP = inst.exports.malloc(24 /* sizeof(struct xz_buf) */);
  if (!bufP) throw new Error('malloc buf null');

  const inSize = inBuf.byteLength;

  let inP, outP;
  inP = inst.exports.malloc(inSize);
  if (!inP) throw new Error(`malloc in ${inSize} null`);
  outP = inst.exports.malloc(outSize);
  if (!outP) throw new Error(`malloc out ${outSize} null`);

  const inU8 = new Uint8Array(inst.exports.memory.buffer, inP, inSize);
  inU8.set(new Uint8Array(inBuf));
  const bufU32A = new Uint32Array(inst.exports.memory.buffer, bufP, 6);
  bufU32A[0 /* in */] = inP;
  bufU32A[1 /* in_pos */] = 0;
  bufU32A[2 /* in_size */] = inSize;
  bufU32A[3 /* out */] = outP;
  bufU32A[4 /* out_pos */] = 0;
  bufU32A[5 /* out_size */] = outSize;

  console.log('xz_dec_run');
  const runResult = inst.exports.xz_dec_run(decP, bufP);
  if (runResult !== 1 /* XZ_STREAM_END */) throw new Error(`xz_dec_run result ${runResult} not stream end`);

  const bufU32B = new Uint32Array(inst.exports.memory.buffer, bufP, 6);
  const outPos = bufU32B[4 /* out_pos */];
  const outBuf = inst.exports.memory.buffer.slice(outP, outP + outPos);
  return outBuf;
}

function narinfoVisitFields(narinfo, handler) {
  const pattern = /^([^:]*): (.*)\n/mg;
  let m;
  while (m = pattern.exec(narinfo)) {
    handler(m[1], m[2]);
  }
}

function narinfoPath(narinfo) {
  let rootPath;
  narinfoVisitFields(narinfo, (k, v) => {
    switch (k) {
      case 'StorePath':
        rootPath = v;
        break;
    }
  });
  return rootPath;
}

const PATH_PATTERN = /\/([0-9a-z]{32})-([^/]+)(.*)/;

function pathMatch(path) {
  return PATH_PATTERN.exec(path);
}

function pathHash(path) {
  return pathMatch(path)[1];
}

function pathName(path) {
  return pathMatch(path)[2];
}

function narReadInt(reader) {
  const i = reader.data.getBigInt64(reader.pos, true);
  reader.pos += 8;
  return Number(i);
};

function narReadU8(reader) {
  const length = narReadInt(reader);
  const paddedLength = (length + 7) & -8;
  const u8 = new Uint8Array(reader.buf, reader.pos, length);
  reader.pos += paddedLength;
  return u8;
};

function narReadString(reader) {
  return new TextDecoder().decode(narReadU8(reader));
}

function narExpectString(reader, expected) {
  const s = narReadString(reader, expected);
  if (s !== expected) throw new Error(`unexpected '${s}', expected '${expected}'`);
}

function narReadPairs(reader, handler) {
  narExpectString(reader, '(');
  while (true) {
    const k = narReadString(reader);
    if (k === ')') break;
    handler(k);
  }
}

function narReadDirEntry(reader) {
  const entry = {};
  narReadPairs(reader, (k) => {
    switch (k) {
      case 'name':
        entry.name = narReadString(reader);
        break;
      case 'node':
        entry.node = narReadNode(reader);
        break;
      default:
        throw new Error(`unrecognized key ${k}`);
    }
  });
  return entry;
}

function narReadNode(reader) {
  const node = {};
  narReadPairs(reader, (k) => {
    switch (k) {
      case 'type':
        node.type = narReadString(reader);
        switch (node.type) {
          case 'regular':
            node.executable = false;
            break;
          case 'directory':
            node.entries = [];
            break;
        }
        break;
      case 'executable':
        narExpectString(reader, '');
        node.executable = true;
        break;
      case 'contents':
        node.contents = narReadU8(reader);
        break;
      case 'target':
        node.target = narReadString(reader);
        break;
      case 'entry':
        node.entries.push(narReadDirEntry(reader));
        break;
      default:
        throw new Error(`unrecognized key ${k}`);
    }
  });
  return node;
}

function narRead(buf) {
  const reader = {
    buf,
    data: new DataView(buf),
    pos: 0,
  };
  narExpectString(reader, 'nix-archive-1');
  return {root: narReadNode(reader)};
}

function narNavigate(nar, path) {
  let node = nar.root;
  const names = path.split('/');
  for (const name of names) {
    if (!name) continue;
    if (node.type !== 'directory') throw new Error(`navigate nar node type ${node.type}, expected directory`);
    const entry = node.entries.find((e) => e.name === name);
    if (!entry) throw new Error(`navigate nar name ${name} not found`);
    node = entry.node;
  }
  return node;
}

function drvParse(drvText) {
  const drvMunged = drvText.replace(/"(?:[^"\\]|\\.)*"|(Derive)|(\()|(\))/g, (orig, derive, lparen, rparen) => {
    if (derive) return '';
    if (lparen) return '[';
    if (rparen) return ']';
    return orig;
  });
  return JSON.parse(drvMunged);
}

async function cacheGetNarinfo(base, hash) {
  const narinfoUrl = `${base}${hash}.narinfo`;
  return await fetchOkText(narinfoUrl);
}

async function cacheGetNar(base, narinfo) {
  let narXzUrl, compression, narXzSize, narSize;
  narinfoVisitFields(narinfo, (k, v) => {
    switch (k) {
      case 'URL':
        narXzUrl = new URL(v, base).href;
        break;
      case 'Compression':
        compression = v;
        if (compression !== 'xz') throw new Error(`narinfo unsupported compression ${compression}`);
        break;
      case 'FileSize':
        narXzSize = +v;
        break;
      case 'NarSize':
        narSize = +v;
        break;
    }
  });

  console.log('download nar xz');
  const narXzBuf = await fetchOkBuf(narXzUrl);
  if (narXzBuf.byteLength !== narXzSize) throw new Error(`nar xz ${narXzBuf.byteLength} bytes, expected ${narXzSize}`);

  console.log('decompress nar xz');
  const narBuf = await xzDecompress(narXzBuf, narSize);
  if (narBuf.byteLength !== narSize) throw new Error(`drv nar ${narBuf.byteLength} bytes, expected ${narSize}`);

  console.log('read nar');
  return narRead(narBuf);
}

function dbParse(dumpText) {
  const db = {};
  const linePattern = /^(.*)\n/gm;
  while (true) {
    const m = linePattern.exec(dumpText);
    if (!m) break;
    const path = m[1];
    const narHash = linePattern.exec(dumpText)[1];
    const narSize = +linePattern.exec(dumpText)[1];
    const deriver = linePattern.exec(dumpText)[1];
    const numReferences = +linePattern.exec(dumpText)[1];
    const references = new Array(numReferences);
    for (let i = 0; i < numReferences; i++) {
      references[i] = linePattern.exec(dumpText)[1];
    }
    db[path] = {narHash, narSize, deriver, references};
  }
  return db;
}

function dbReferrers(db) {
  const referrers = {};
  for (const path in db) {
    for (const reference in db[path].references) {
      if (!(reference in referrers)) {
        referrers[reference] = [];
      }
      referrers[reference].push(path);
    }
  }
  return referrers;
}

function uiNodify(text, pattern, replacer) {
  const frag = document.createDocumentFragment();
  let lastEnd = 0;
  while (true) {
    const m = pattern.exec(text);
    if (!m) break;
    const node = replacer(m, text);
    if (!node) continue;
    if (lastEnd < m.index) {
      frag.appendChild(document.createTextNode(text.slice(lastEnd, m.index)));
    }
    frag.appendChild(node);
    lastEnd = pattern.lastIndex;
  }
  if (lastEnd < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastEnd)));
  }
  return frag;
}
