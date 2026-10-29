-- 意見の本文を 1 つにする（design.md §5）: 主張・理由・修正案を「本文」にまとめる。
-- 本文は空でもよい。既存の意見は、主張に理由と修正案を見出し付きで続けて移す。
ALTER TABLE opinions ADD COLUMN body TEXT NOT NULL DEFAULT '';
UPDATE opinions SET body = claim
  || CASE WHEN reason != '' THEN char(10) || char(10) || '理由: ' || reason ELSE '' END
  || CASE WHEN suggestion != '' THEN char(10) || char(10) || '修正案: ' || suggestion ELSE '' END;
ALTER TABLE opinions DROP COLUMN claim;
ALTER TABLE opinions DROP COLUMN reason;
ALTER TABLE opinions DROP COLUMN suggestion;
