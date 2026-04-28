export type User = {
  id: string;
  display_login: string;
  avatar_url?: string | null;
  terms_version?: string | null;
  privacy_version?: string | null;
};

export type AgreementAcceptance = {
  accepted_terms: boolean;
  terms_version: string;
  privacy_version: string;
};

export type QrStartResponse = {
  session_id: string;
  qr_url: string;
  expires_in_seconds: number;
  mock: boolean;
};

export type QrStatusResponse = {
  status: "pending" | "confirmed" | "failed" | "expired";
  message?: string | null;
  access_token?: string | null;
  user?: User | null;
};

export type DeviceStartResponse = {
  session_id: string;
  user_code: string;
  verification_url: string;
  expires_in_seconds: number;
  interval_seconds: number;
  mock: boolean;
};

export type GraphNode = {
  id: string;
  name: string;
  image?: string | null;
  listenCount: number;
  trackCount: number;
  knownTrackCount?: number | null;
  waveTrackCount?: number | null;
  collectionTrackCount?: number | null;
  collectionAlbumCount?: number | null;
  listenedTracks: string[];
  isShared: boolean;
  isSimilarOnly: boolean;
  isCatalogOnly: boolean;
  isLikedArtist: boolean;
  clusterId?: string | null;
};

export type GraphCluster = {
  id: string;
  label: string;
  color: string;
  nodeIds: string[];
  size: number;
  totalListenCount: number;
  totalTrackCount: number;
  topArtists: string[];
};

export type GraphOverlayMatch = {
  userId: string;
  label: string;
  color: string;
  friendScore: number;
  myScore: number;
  commonTracks: string[];
};

export type GraphEdge = {
  source: string;
  target: string;
  type: "collab" | "similar" | "catalog_collab" | string;
  weight: number;
  tracks: string[];
};

export type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  sourceStatus: Record<string, string>;
};

export type SyncStartResponse = {
  job_id: string;
  status: string;
};

export type SyncStatusResponse = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  message?: string | null;
  sourceStatus: Record<string, string>;
  error?: string | null;
};

export type Friend = {
  id: string;
  friend: User;
  created_at: string;
  can_view_full_graph: boolean;
};

export type FriendsResponse = {
  friends: Friend[];
};

export type InviteCreateResponse = {
  code: string;
  invite_url: string;
  expires_at: string;
};

export type CompareResponse = {
  friendId: string;
  sharedArtistIds: string[];
  sharedCount: number;
  myArtistCount: number;
  friendArtistCount: number;
  overlapPercent: number;
};

export type PlaylistSource =
  | "known"
  | "liked"
  | "wave"
  | "graph"
  | "friend_common"
  | "unheard_collabs"
  | "unheard_liked_collabs"
  | "friend_unheard_collabs";

export type PlaylistBuildRequest = {
  source: PlaylistSource;
  limit: number;
  artist_id?: string | null;
  friend_id?: string | null;
};

export type PlaylistCreateRequest = PlaylistBuildRequest & {
  title: string;
  visibility: "private" | "public";
};

export type PlaylistTrack = {
  id: string;
  title: string;
  artists: string[];
  cover?: string | null;
  albumId?: string | null;
  sources: string[];
};

export type PlaylistPreviewResponse = {
  source: PlaylistSource;
  titleSuggestion: string;
  totalAvailable: number;
  usableCount: number;
  skippedWithoutAlbum: number;
  tracks: PlaylistTrack[];
};

export type PlaylistCreateResponse = {
  title: string;
  kind: string | number;
  url?: string | null;
  addedCount: number;
  skippedWithoutAlbum: number;
  tracks: PlaylistTrack[];
};
