import { ValidationError } from '@/lib/errors';

/**
 * ===========================================================================
 * UPLOAD VALIDATION (specification §36 — decisions §13)
 * ===========================================================================
 * A file's EXTENSION is a claim made by whoever uploaded it. Its first bytes
 * are evidence. Everything here works from the evidence.
 *
 * Accepted, by the owner's decision: PDF, Excel, DWG (AutoCAD), Revit, and
 * compressed archives, plus the general engineering document formats already
 * in the catalogue.
 *
 * ARCHIVES ARE NEVER EXTRACTED. The platform stores and serves them as opaque
 * bytes and never decompresses one, which is what makes a zip bomb a
 * non-issue rather than something to defend against.
 * ===========================================================================
 */

/** Container families a file's first bytes can identify. */
export type ContainerFormat =
  | 'PDF'
  | 'ZIP_CONTAINER' // .zip, and also .xlsx/.docx, which are ZIPs
  | 'OLE_COMPOUND' // legacy .xls, and .rvt/.rfa — Revit uses this container
  | 'DWG'
  | 'DXF_TEXT'
  | 'RAR'
  | 'SEVEN_ZIP'
  | 'UNKNOWN';

export type ProductFileType =
  | 'PDF'
  | 'EXCEL'
  | 'CAD'
  | 'REVIT_BIM'
  | 'ARCHIVE'
  | 'TEMPLATE'
  | 'PROJECT'
  | 'OTHER';

interface Signature {
  readonly format: ContainerFormat;
  readonly offset: number;
  readonly bytes: readonly number[];
}

const SIGNATURES: readonly Signature[] = [
  { format: 'PDF', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { format: 'ZIP_CONTAINER', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { format: 'ZIP_CONTAINER', offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { format: 'ZIP_CONTAINER', offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] }, // spanned
  // Microsoft Compound File Binary — legacy Office AND Autodesk Revit.
  { format: 'OLE_COMPOUND', offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { format: 'RAR', offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] }, // RAR4
  { format: 'RAR', offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00] }, // RAR5
  { format: 'SEVEN_ZIP', offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
];

/**
 * AutoCAD DWG files open with "AC" followed by a four-digit version code
 * (AC1015 = 2000, AC1032 = 2018...). Matching the pattern rather than a fixed
 * list means a future AutoCAD release does not need a code change.
 */
const DWG_PATTERN = /^AC[0-9]{4}$/;

export function detectContainer(head: Uint8Array): ContainerFormat {
  for (const signature of SIGNATURES) {
    const slice = head.subarray(signature.offset, signature.offset + signature.bytes.length);
    if (
      slice.length === signature.bytes.length &&
      signature.bytes.every((byte, index) => slice[index] === byte)
    ) {
      return signature.format;
    }
  }

  const first6 = Buffer.from(head.subarray(0, 6)).toString('latin1');
  if (DWG_PATTERN.test(first6)) return 'DWG';

  // DXF is plain text; the drawing always opens with a SECTION group.
  const first256 = Buffer.from(head.subarray(0, 256)).toString('latin1');
  if (/^\s*0\s*[\r\n]+\s*SECTION/.test(first256)) return 'DXF_TEXT';

  return 'UNKNOWN';
}

/**
 * Which containers a declared product type may legitimately arrive in.
 *
 * Note the overlaps, which are facts about the formats and not gaps here:
 * .xlsx and .zip are both ZIP containers; legacy .xls and Revit .rvt are both
 * OLE compound files. Byte inspection therefore proves the file belongs to an
 * ALLOWED FAMILY — it cannot prove a .rvt is not a renamed .xls. That
 * distinction is a content-quality question, which the owner settles during
 * review before publication; what this blocks is an executable or a script
 * wearing an engineering extension.
 */
const ALLOWED_CONTAINERS: Readonly<Record<ProductFileType, readonly ContainerFormat[]>> = {
  PDF: ['PDF'],
  EXCEL: ['ZIP_CONTAINER', 'OLE_COMPOUND'],
  CAD: ['DWG', 'DXF_TEXT', 'ZIP_CONTAINER'],
  REVIT_BIM: ['OLE_COMPOUND', 'ZIP_CONTAINER'],
  ARCHIVE: ['ZIP_CONTAINER', 'RAR', 'SEVEN_ZIP'],
  TEMPLATE: ['PDF', 'ZIP_CONTAINER', 'OLE_COMPOUND', 'DWG', 'DXF_TEXT'],
  PROJECT: ['ZIP_CONTAINER', 'RAR', 'SEVEN_ZIP', 'DWG', 'OLE_COMPOUND', 'PDF'],
  OTHER: ['PDF', 'ZIP_CONTAINER', 'OLE_COMPOUND', 'DWG', 'DXF_TEXT', 'RAR', 'SEVEN_ZIP'],
};

/** Extensions offered in the upload dialog, per declared type. */
export const ALLOWED_EXTENSIONS: Readonly<Record<ProductFileType, readonly string[]>> = {
  PDF: ['.pdf'],
  EXCEL: ['.xlsx', '.xlsm', '.xls'],
  CAD: ['.dwg', '.dxf', '.zip'],
  REVIT_BIM: ['.rvt', '.rfa', '.rte', '.zip'],
  ARCHIVE: ['.zip', '.rar', '.7z'],
  TEMPLATE: ['.pdf', '.xlsx', '.dwg', '.rvt', '.zip'],
  PROJECT: ['.zip', '.rar', '.7z', '.dwg', '.rvt', '.pdf'],
  OTHER: ['.pdf', '.xlsx', '.dwg', '.dxf', '.rvt', '.rfa', '.zip', '.rar', '.7z'],
};

/**
 * Size ceilings, in bytes. Revit models and project archives are genuinely
 * large; a PDF that size is a mistake or an attack.
 */
export const MAX_UPLOAD_BYTES: Readonly<Record<ProductFileType, number>> = {
  PDF: 200 * 1024 * 1024,
  EXCEL: 100 * 1024 * 1024,
  CAD: 300 * 1024 * 1024,
  REVIT_BIM: 1024 * 1024 * 1024,
  ARCHIVE: 1024 * 1024 * 1024,
  TEMPLATE: 200 * 1024 * 1024,
  PROJECT: 1024 * 1024 * 1024,
  OTHER: 300 * 1024 * 1024,
};

/** Formats that can produce a public preview. Owner decision: PDF only. */
export function supportsPreview(fileType: ProductFileType): boolean {
  return fileType === 'PDF';
}

export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index).toLowerCase();
}

export interface UploadCandidate {
  readonly filename: string;
  readonly declaredType: ProductFileType;
  readonly byteSize: number;
  /** At least the first 512 bytes of the file. */
  readonly head: Uint8Array;
}

export interface UploadVerdict {
  readonly container: ContainerFormat;
  readonly extension: string;
}

/**
 * Accept or reject an upload. Throws with a specific reason rather than a
 * generic failure, because the person uploading is a trusted contributor who
 * needs to know what to fix.
 */
export function validateUpload(candidate: UploadCandidate): UploadVerdict {
  const { filename, declaredType, byteSize, head } = candidate;

  if (byteSize <= 0) {
    throw new ValidationError('الملف فارغ');
  }

  const limit = MAX_UPLOAD_BYTES[declaredType];
  if (byteSize > limit) {
    throw new ValidationError('حجم الملف يتجاوز الحد المسموح', {
      byteSize,
      limitBytes: limit,
      // Megabytes for a human-readable message, not a monetary amount.
      // eslint-disable-next-line no-restricted-properties
      limitMb: Math.round(limit / 1024 / 1024),
    });
  }

  const extension = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS[declaredType].includes(extension)) {
    throw new ValidationError('امتداد الملف غير مقبول لهذا النوع', {
      extension,
      allowed: ALLOWED_EXTENSIONS[declaredType],
    });
  }

  if (head.length < 8) {
    throw new ValidationError('تعذّر قراءة بداية الملف للتحقق منه');
  }

  const container = detectContainer(head);
  if (container === 'UNKNOWN') {
    throw new ValidationError('تعذّر التعرف على صيغة الملف من محتواه', { extension });
  }

  if (!ALLOWED_CONTAINERS[declaredType].includes(container)) {
    // The extension said one thing and the bytes said another.
    throw new ValidationError('محتوى الملف لا يطابق النوع المعلن', {
      declaredType,
      detected: container,
      extension,
    });
  }

  return { container, extension };
}
