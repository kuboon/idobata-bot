-- 本文を主張に戻す（理由と修正案は分けられないので空のまま）。
ALTER TABLE opinions ADD COLUMN claim TEXT NOT NULL DEFAULT '';
ALTER TABLE opinions ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE opinions ADD COLUMN suggestion TEXT NOT NULL DEFAULT '';
UPDATE opinions SET claim = body;
ALTER TABLE opinions DROP COLUMN body;
