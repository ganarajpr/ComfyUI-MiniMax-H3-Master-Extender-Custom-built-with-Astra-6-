An outline of a film has {{got}} beats but must have exactly {{clips}}: {{excess}} too many. Merge neighbouring beats until exactly {{clips}} remain. Only merge beats that are consecutive and are really one moment, or are the two thinnest moments; never touch the first or last beat's role (the story keeps its opening and its ending). Language: {{language}}{{script_note}}.

THE BEATS:
{{numbered}}

Answer with ONE JSON object and nothing else. "merges" lists ONLY the merged groups: each has "from" (the consecutive beat numbers merged, at least two), "beat" (the merged moment as one line of at most 60 words, keeping the speech that matters, spoken lines between curly quotes “like this”) and "end_state" ({"place": "...", "present": ["..."], "state": "..."} when the merged moment ends). The groups must remove exactly {{excess}} beats in all (a group of k beats removes k-1), and no number may be in two groups.
{"merges": [{"from": [3, 4], "beat": "...", "end_state": {"place": "...", "present": ["..."], "state": "..."}}]}
