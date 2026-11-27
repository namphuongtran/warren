-- namphuongtran/warren#25: a handoff open question is now an object
-- ({ question, options, recommendation }). Rewrite each bare-string question
-- stored before that change, in order. Rows in the new shape are untouched.
UPDATE "runs"
SET "handoff_json" = jsonb_set(
	"handoff_json",
	'{handoff,openQuestions}',
	(
		SELECT jsonb_agg(
			CASE
				WHEN jsonb_typeof("q"."value") = 'string'
					THEN jsonb_build_object('question', "q"."value", 'options', '[]'::jsonb, 'recommendation', NULL)
				ELSE "q"."value"
			END
			ORDER BY "q"."ordinality"
		)
		FROM jsonb_array_elements("runs"."handoff_json" -> 'handoff' -> 'openQuestions')
			WITH ORDINALITY AS "q"("value", "ordinality")
	)
)
WHERE "handoff_json" ->> 'state' = 'recorded'
	AND jsonb_typeof("handoff_json" -> 'handoff' -> 'openQuestions') = 'array'
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements("runs"."handoff_json" -> 'handoff' -> 'openQuestions') AS "e"("value")
		WHERE jsonb_typeof("e"."value") = 'string'
	);
