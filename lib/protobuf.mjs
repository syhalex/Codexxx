function readVarint(bytes, offset) {
  let value = 0;
  for (let factor = 1; offset < bytes.length && factor <= 2 ** 63; factor *= 128) {
    const byte = bytes[offset++];
    value += (byte & 127) * factor;
    if (byte < 128) return [value, offset];
  }
  throw new Error('Invalid protobuf varint');
}

export function firstPackedVarint(bytes) {
  if (bytes instanceof Uint8Array && bytes.length) return readVarint(bytes, 0)[0];
  if (typeof bytes === 'number') return bytes;
}

export function* protoFields(bytes) {
  if (!(bytes instanceof Uint8Array)) return;
  let offset = 0;
  const read = () => {
    const [value, end] = readVarint(bytes, offset);
    offset = end;
    return value;
  };
  while (offset < bytes.length) {
    const tag = read();
    const wire = tag % 8;
    const id = Math.floor(tag / 8);
    if (wire === 0) yield [id, read()];
    else if (wire === 2) {
      const length = read();
      const end = offset + length;
      if (end > bytes.length) throw new Error('Invalid protobuf field length');
      yield [id, bytes.subarray(offset, end)];
      offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
    } else throw new Error('Unknown protobuf wire type');
  }
}

export function protoField(bytes, field) {
  for (const [id, value] of protoFields(bytes)) if (id === field) return value;
}
