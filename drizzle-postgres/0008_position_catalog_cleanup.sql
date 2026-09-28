DO $$
BEGIN
  UPDATE "position_catalog"
  SET "active" = 0
  WHERE "active" = 1
    AND ("employment_type", "department", "position") IN (
      ('ОПР', 'УСР', 'Стропальщик'),
      ('ОПР', 'УСР', 'Мастер строительно-монтажных работ'),
      ('ОПР', 'УСР', 'Монтажник металлоконструкций'),
      ('ОПР', 'УСР', 'Подсобный рабочий'),
      ('ОПР', 'УСР', 'Электрогазосварщик'),
      ('ОПР', 'УСР', 'Монтажник технологических трубопроводов'),
      ('ИТР', 'ОП', 'Начальник'),
      ('АХО', 'ИС', 'Ахун')
    );

  UPDATE "personnel_options"
  SET "active" = 0
  WHERE "active" = 1
    AND (
      ("kind" = 'employmentType' AND NOT EXISTS (
        SELECT 1 FROM "position_catalog" WHERE "active" = 1 AND "employment_type" = "personnel_options"."name"
      ))
      OR ("kind" = 'department' AND NOT EXISTS (
        SELECT 1 FROM "position_catalog" WHERE "active" = 1 AND "department" = "personnel_options"."name"
      ))
      OR ("kind" = 'position' AND NOT EXISTS (
        SELECT 1 FROM "position_catalog" WHERE "active" = 1 AND "position" = "personnel_options"."name"
      ))
    );
END $$;
