DO $$
DECLARE
  used_positions integer;
BEGIN
  SELECT COUNT(*)::integer
  INTO used_positions
  FROM "employees"
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

  IF used_positions > 0 THEN
    RAISE EXCEPTION 'Очистка справочника остановлена: % активных сотрудников используют удаляемые должности.', used_positions;
  END IF;

  DELETE FROM "position_catalog"
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
