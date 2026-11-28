-- namphuongtran/warren#25: a handoff open question is now an object
-- ({ question, options, recommendation }). Rewrite each bare-string question
-- stored before that change, in order. Rows in the new shape are untouched.
-- The outer json() matters: a JSON value loses its JSON subtype when it
-- leaves a subquery on some SQLite builds, and json_set would then store
-- the whole array as one quoted string.
UPDATE `runs`
SET `handoff_json` = json_set(
	`handoff_json`,
	'$.handoff.openQuestions',
	json((
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
	))
)
WHERE json_extract(`handoff_json`, '$.state') = 'recorded'
	AND json_type(`handoff_json`, '$.handoff.openQuestions') = 'array'
	AND EXISTS (
		SELECT 1
		FROM json_each(`runs`.`handoff_json`, '$.handoff.openQuestions')
		WHERE `type` = 'text'
	);
