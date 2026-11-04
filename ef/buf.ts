export class Buf {
  b: number[] = [];
  u8(n: number): this { this.b.push(n & 0xff); return this; }
  lebU(n: number): this {
    n >>>= 0;
    do {
      let byte = n & 0x7f;
      n >>>= 7;
      if (n !== 0) byte |= 0x80;
      this.b.push(byte);
    } while (n !== 0);
    return this;
  }
  lebS(n: number): this {
    n |= 0;
    for (;;) {
      const byte = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
        this.b.push(byte);
        return this;
      }
      this.b.push(byte | 0x80);
    }
  }
  f64(x: number): this {
    const ab = new ArrayBuffer(8);
    new DataView(ab).setFloat64(0, x, true);
    for (const v of new Uint8Array(ab)) this.b.push(v);
    return this;
  }
  bytes(bs: ArrayLike<number>): this {
    for (let i = 0; i < bs.length; i++) this.b.push(bs[i] & 0xff);
    return this;
  }
  name(s: string): this {
    this.lebU(s.length);
    for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 0xff);
    return this;
  }
}
