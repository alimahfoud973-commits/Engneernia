import { describe, it, expect } from 'vitest';
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  detectContainer,
  extensionOf,
  supportsPreview,
  validateUpload,
  type ProductFileType,
} from './file-types';
import { ValidationError } from '@/lib/errors';

const head = (...bytes: number[]) => Uint8Array.from([...bytes, ...new Array(64).fill(0)]);
const ascii = (text: string) =>
  Uint8Array.from([...Buffer.from(text, 'latin1'), ...new Array(64).fill(0)]);

const PDF = head(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const ZIP = head(0x50, 0x4b, 0x03, 0x04);
const OLE = head(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const DWG = ascii('AC1032');
const RAR4 = head(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00);
const RAR5 = head(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00);
const SEVENZ = head(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c);
const ELF = head(0x7f, 0x45, 0x4c, 0x46); // a Linux executable
const MZ = head(0x4d, 0x5a, 0x90, 0x00); // a Windows executable

describe('container detection', () => {
  it('identifies every accepted family', () => {
    expect(detectContainer(PDF)).toBe('PDF');
    expect(detectContainer(ZIP)).toBe('ZIP_CONTAINER');
    expect(detectContainer(OLE)).toBe('OLE_COMPOUND');
    expect(detectContainer(DWG)).toBe('DWG');
    expect(detectContainer(RAR4)).toBe('RAR');
    expect(detectContainer(RAR5)).toBe('RAR');
    expect(detectContainer(SEVENZ)).toBe('SEVEN_ZIP');
    expect(detectContainer(ascii('  0\r\nSECTION\r\n'))).toBe('DXF_TEXT');
  });

  it('recognises DWG across AutoCAD versions, including future ones', () => {
    for (const version of ['AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032', 'AC1099']) {
      expect(detectContainer(ascii(version)), version).toBe('DWG');
    }
  });

  it('does not mistake arbitrary text starting with AC for a drawing', () => {
    expect(detectContainer(ascii('ACCOUNT'))).toBe('UNKNOWN');
    expect(detectContainer(ascii('AC12'))).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for executables', () => {
    expect(detectContainer(ELF)).toBe('UNKNOWN');
    expect(detectContainer(MZ)).toBe('UNKNOWN');
  });
});

describe('accepting what the owner asked for', () => {
  const cases: ReadonlyArray<readonly [ProductFileType, string, Uint8Array]> = [
    ['PDF', 'book.pdf', PDF],
    ['EXCEL', 'loads.xlsx', ZIP],
    ['EXCEL', 'legacy.xls', OLE],
    ['CAD', 'plan.dwg', DWG],
    ['CAD', 'plan.dxf', ascii('  0\r\nSECTION')],
    ['REVIT_BIM', 'model.rvt', OLE],
    ['REVIT_BIM', 'family.rfa', OLE],
    ['ARCHIVE', 'pack.zip', ZIP],
    ['ARCHIVE', 'pack.rar', RAR5],
    ['ARCHIVE', 'pack.7z', SEVENZ],
    ['PROJECT', 'project.zip', ZIP],
  ];

  for (const [type, filename, bytes] of cases) {
    it(`accepts ${filename} declared as ${type}`, () => {
      const verdict = validateUpload({
        filename,
        declaredType: type,
        byteSize: 1024,
        head: bytes,
      });
      expect(verdict.extension).toBe(filename.slice(filename.lastIndexOf('.')));
    });
  }
});

describe('rejecting what should not get in', () => {
  it('rejects a Linux executable renamed as a Revit model', () => {
    expect(() =>
      validateUpload({ filename: 'model.rvt', declaredType: 'REVIT_BIM', byteSize: 1024, head: ELF }),
    ).toThrow(ValidationError);
  });

  it('rejects a Windows executable renamed as a drawing', () => {
    expect(() =>
      validateUpload({ filename: 'plan.dwg', declaredType: 'CAD', byteSize: 1024, head: MZ }),
    ).toThrow(ValidationError);
  });

  it('rejects a PDF uploaded under an archive declaration', () => {
    expect(() =>
      validateUpload({ filename: 'pack.zip', declaredType: 'ARCHIVE', byteSize: 1024, head: PDF }),
    ).toThrow(ValidationError);
  });

  it('rejects an extension the declared type does not offer', () => {
    expect(() =>
      validateUpload({ filename: 'sheet.txt', declaredType: 'EXCEL', byteSize: 1024, head: ZIP }),
    ).toThrow(ValidationError);
  });

  it('rejects an empty file', () => {
    expect(() =>
      validateUpload({ filename: 'x.pdf', declaredType: 'PDF', byteSize: 0, head: PDF }),
    ).toThrow(ValidationError);
  });

  it('rejects a file over the type limit', () => {
    expect(() =>
      validateUpload({
        filename: 'huge.pdf',
        declaredType: 'PDF',
        byteSize: MAX_UPLOAD_BYTES.PDF + 1,
        head: PDF,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a file whose head is too short to inspect', () => {
    expect(() =>
      validateUpload({
        filename: 'x.pdf',
        declaredType: 'PDF',
        byteSize: 4,
        head: Uint8Array.from([0x25, 0x50]),
      }),
    ).toThrow(ValidationError);
  });

  it('names the reason, so a contributor knows what to fix', () => {
    try {
      validateUpload({ filename: 'model.rvt', declaredType: 'REVIT_BIM', byteSize: 1024, head: ELF });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as ValidationError).details).toHaveProperty('extension', '.rvt');
    }
  });
});

describe('preview policy — owner decision: PDF only', () => {
  it('offers a preview for PDF and for nothing else', () => {
    const types: readonly ProductFileType[] = [
      'PDF', 'EXCEL', 'CAD', 'REVIT_BIM', 'ARCHIVE', 'TEMPLATE', 'PROJECT', 'OTHER',
    ];
    for (const type of types) {
      expect(supportsPreview(type), type).toBe(type === 'PDF');
    }
  });
});

describe('configuration sanity', () => {
  it('gives every product type an extension list and a size limit', () => {
    const types = Object.keys(ALLOWED_EXTENSIONS) as ProductFileType[];
    for (const type of types) {
      expect(ALLOWED_EXTENSIONS[type].length, type).toBeGreaterThan(0);
      expect(MAX_UPLOAD_BYTES[type], type).toBeGreaterThan(0);
    }
  });

  it('lists extensions in lowercase with a leading dot', () => {
    for (const list of Object.values(ALLOWED_EXTENSIONS)) {
      for (const ext of list) {
        expect(ext).toMatch(/^\.[a-z0-9]+$/);
      }
    }
  });

  it('extracts extensions case-insensitively', () => {
    expect(extensionOf('MODEL.RVT')).toBe('.rvt');
    expect(extensionOf('noextension')).toBe('');
  });
});
