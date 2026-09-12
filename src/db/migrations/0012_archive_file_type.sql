-- The owner asked for the platform to accept compressed archives alongside
-- DWG and Revit files, so ARCHIVE joins the product file types.
--
-- Archives are stored and delivered as opaque bytes and are NEVER extracted
-- server-side, which is why a compression bomb is not a threat this platform
-- has to defend against.
ALTER TYPE "file_type" ADD VALUE IF NOT EXISTS 'ARCHIVE';
