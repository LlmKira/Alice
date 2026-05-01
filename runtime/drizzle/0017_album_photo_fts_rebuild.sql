DROP TRIGGER IF EXISTS album_photos_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS album_photos_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS album_photos_au;
--> statement-breakpoint
DROP TABLE IF EXISTS album_photo_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS album_photo_fts USING fts5(
  search_text,
  tokenize='better_trigram'
);
--> statement-breakpoint
INSERT INTO album_photo_fts(rowid, search_text)
SELECT
  id,
  coalesce(caption_text, '') || ' ' ||
  coalesce(description, '') || ' ' ||
  coalesce(wd_tags_json, '') || ' ' ||
  coalesce(ocr_text, '')
FROM album_photos;
--> statement-breakpoint
CREATE TRIGGER album_photos_ai AFTER INSERT ON album_photos BEGIN
  INSERT INTO album_photo_fts(rowid, search_text)
  VALUES (
    new.id,
    coalesce(new.caption_text, '') || ' ' ||
    coalesce(new.description, '') || ' ' ||
    coalesce(new.wd_tags_json, '') || ' ' ||
    coalesce(new.ocr_text, '')
  );
END;
--> statement-breakpoint
CREATE TRIGGER album_photos_ad AFTER DELETE ON album_photos BEGIN
  DELETE FROM album_photo_fts WHERE rowid = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER album_photos_au AFTER UPDATE OF caption_text, description, wd_tags_json, ocr_text ON album_photos BEGIN
  DELETE FROM album_photo_fts WHERE rowid = old.id;
  INSERT INTO album_photo_fts(rowid, search_text)
  VALUES (
    new.id,
    coalesce(new.caption_text, '') || ' ' ||
    coalesce(new.description, '') || ' ' ||
    coalesce(new.wd_tags_json, '') || ' ' ||
    coalesce(new.ocr_text, '')
  );
END;
