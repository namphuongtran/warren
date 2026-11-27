-- namphuongtran/warren#25: a handoff open question is now an object
-- ({ question, options, recommendation }). Rewrite each bare-string question
-- stored before that change, in order. Rows in the new shape are untouched.
UPDATE `runs`
SET `handoff_json` = json_set(
	`handoff_json`,
	'$.handoff.openQuestions',
	(
		SELECT json_group_array(
			CASE
				WHEN `q`.`type` = 'text'
					THEN json_object('question', `q`.`value`, 'options', json_array(), 'recommendation', NULL)
				ELSE json(`q`.`value`)
			END
		)
		FROM (
			SELECT `type`, `value`
			FROM json_each(`runs`.`handoff_json`, '$.handoff.openQuestions')
			ORDER BY `key`
		) AS `q`
	)
)
WHERE json_extract(`handoff_json`, '$.state') = 'recorded'
	AND json_type(`handoff_json`, '$.handoff.openQuestions') = 'array'
	AND EXISTS (
		SELECT 1
		FROM json_each(`runs`.`handoff_json`, '$.handoff.openQuestions')
		WHERE `type` = 'text'
	);
