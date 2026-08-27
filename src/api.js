const GRAPHQL_ENDPOINT = "/graphql";

// Bounds how long a hung connection can pin a caller's in-flight guard
// (e.g. badge-injector's cardsInjecting/detailInjecting, both reset
// correctly in `finally` for normal rejections — this just gives a hang
// something to reject *with*).
const REQUEST_TIMEOUT_MS = 20000;

async function execGraphQL(query, variables) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      credentials: "include", // carries Stash session cookie, same-origin
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();

  // Stash's GraphQL server returns HTTP 200 even when the query/mutation
  // errors out, so res.ok alone won't catch a failed request.
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  return json.data;
}

// Alias: semantic distinction only — reads vs. writes.
export async function gql(query, variables) {
  return execGraphQL(query, variables);
}

export async function gqlMutate(mutation, variables) {
  return execGraphQL(mutation, variables);
}

export const PERFORMER_FIELDS = `
  id
  name
  disambiguation
  image_path
  rating100
  custom_fields
  gender
  country
  height_cm
  birthdate
  death_date
  favorite
  urls
  scene_count
  image_count
  gallery_count
  group_count
  o_counter
  tags { id name performer_count }

  # Chip-only fields — consumed by card-chips.js, not by the native card or
  # rating math. tags.performer_count backs the chip row's tag popularity
  # sort. Don't strip these in a future slimming pass without checking there.
  ethnicity
  eye_color
  hair_color
  measurements
  fake_tits
  tattoos
  piercings
  weight
`;

export const SCENE_FIELDS = `
  id
  title
  code
  date
  rating100
  custom_fields
  organized
  o_counter
  play_count
  resume_time
  play_duration
  files { duration width height video_codec size fingerprints { type value } frame_rate bit_rate audio_codec }
  paths { screenshot preview stream }
  performers { id name image_path favorite scene_count }
  studio { id name image_path }
  tags { id name scene_count }
  groups { group { id name } }
  galleries { id }
  scene_markers { id }
  stash_ids { endpoint stash_id }

  # Chip-only fields — consumed by card-chips.js, not by the native card or
  # rating math. play_count backs the play_count chip; files.frame_rate/
  # bit_rate/audio_codec back the tech chip run; performers.scene_count and
  # tags.scene_count back the chip row's popularity sorts. Don't strip these
  # in a future slimming pass without checking there.
`;

// Matchmaking's candidate pool is up to 500 random items per pick, but only
// the 2 selected (seed + opponent) ever render as a card — the other ~498
// only need rating math + display name for weighting/debug logging. Same
// slim-field precedent as this file's own RANK_FIELDS below.
export const MATCHMAKING_PERFORMER_FIELDS = `
  id
  name
  rating100
  custom_fields
`;

export const MATCHMAKING_SCENE_FIELDS = `
  id
  title
  rating100
  custom_fields
`;

export const FIND_PERFORMERS_CANDIDATES = `
  query FindPerformersCandidates($performer_filter: PerformerFilterType, $filter: FindFilterType) {
    findPerformers(performer_filter: $performer_filter, filter: $filter) {
      count
      performers { ${MATCHMAKING_PERFORMER_FIELDS} }
    }
  }
`;

export const FIND_SCENES_CANDIDATES = `
  query FindScenesCandidates($filter: FindFilterType) {
    findScenes(filter: $filter) {
      count
      scenes { ${MATCHMAKING_SCENE_FIELDS} }
    }
  }
`;

// Follow-up fetch for just the 2 chosen candidates, once selectWeightedPair
// has picked a pair from the slim candidate pool above — full field set so
// the native StashApp PerformerCard/SceneCard (see native-loader.js) still
// gets everything it expects.
export const FIND_PERFORMERS_BY_IDS = `
  query FindPerformersByIds($ids: [ID!]) {
    findPerformers(ids: $ids, filter: { per_page: -1 }) {
      performers { ${PERFORMER_FIELDS} }
    }
  }
`;

export const FIND_SCENES_BY_IDS = `
  query FindScenesByIds($ids: [ID!]) {
    findScenes(ids: $ids, filter: { per_page: -1 }) {
      scenes { ${SCENE_FIELDS} }
    }
  }
`;

// Slim field selection backing rank-cache.js's getRankedItems(): useLeaderboard.js,
// badge-injector.js, and scene-tooltips.js previously each fetched the full
// PERFORMER_FIELDS — including urls, tags, image_path, and five *_count
// fields — just to compute an id -> rank/tier lookup. `name` is included
// alongside the bare rank-math fields (id/rating100/custom_fields) because
// useLeaderboard.js's table renders it. `gender` is included so
// matchmaking.js's startGauntletRun can filter its ladder snapshot by the
// live gender filter without a second fetch.
const RANK_FIELDS = `
  id
  name
  rating100
  gender
  custom_fields
`;

// Same slim precedent, scenes side — `title`, not `name` (MATCHMAKING_SCENE_FIELDS
// above uses the same split).
const SCENE_RANK_FIELDS = `
  id
  title
  rating100
  custom_fields
`;

export const FIND_PERFORMERS_RANK = `
  query FindPerformersRank($performer_filter: PerformerFilterType, $filter: FindFilterType) {
    findPerformers(performer_filter: $performer_filter, filter: $filter) {
      count
      performers { ${RANK_FIELDS} }
    }
  }
`;

// Stash's findScenes exposes no scene_filter argument (unlike findPerformers'
// performer_filter) — same asymmetry loadCandidatePool works around.
export const FIND_SCENES_RANK = `
  query FindScenesRank($filter: FindFilterType) {
    findScenes(filter: $filter) {
      count
      scenes { ${SCENE_RANK_FIELDS} }
    }
  }
`;

// Count-only queries — per_page: 0 skips fetching entities, just the total.
export const COUNT_PERFORMERS = `
  query CountPerformers($performer_filter: PerformerFilterType) {
    findPerformers(performer_filter: $performer_filter, filter: { per_page: 0 }) {
      count
    }
  }
`;

export const COUNT_SCENES = `
  query CountScenes {
    findScenes(filter: { per_page: 0 }) {
      count
    }
  }
`;

export const UPDATE_PERFORMER = `
  mutation UpdatePerformer($id: ID!, $rating100: Int, $custom_fields: CustomFieldsInput!) {
    performerUpdate(input: { id: $id, rating100: $rating100, custom_fields: $custom_fields }) {
      id
    }
  }
`;

export const UPDATE_SCENE = `
  mutation UpdateScene($id: ID!, $rating100: Int, $custom_fields: CustomFieldsInput!) {
    sceneUpdate(input: { id: $id, rating100: $rating100, custom_fields: $custom_fields }) {
      id
    }
  }
`;

// Batched match-log flush (src/stash-log.js) — routed by backend/main.py to
// backend/tasks.py's handle_log_operation, which isn't a plugin task (no
// StashInterface/scope needed), so this bypasses runPluginTask.
export const RUN_PLUGIN_OPERATION = `
  mutation RunPluginOperation($plugin_id: ID!, $args: Map) {
    runPluginOperation(plugin_id: $plugin_id, args: $args)
  }
`;
