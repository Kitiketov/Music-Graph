import type {
  AgreementAcceptance,
  CompareResponse,
  DeviceStartResponse,
  FriendsResponse,
  GraphResponse,
  InviteCreateResponse,
  PlaylistBuildRequest,
  PlaylistCreateRequest,
  PlaylistCreateResponse,
  PlaylistPreviewResponse,
  QrStartResponse,
  QrStatusResponse,
  SyncStartResponse,
  SyncStatusResponse,
  User
} from "../types/api";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const TOKEN_KEY = "music_graph_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  startQr: (agreement: AgreementAcceptance) =>
    request<QrStartResponse>("/auth/qr/start", {
      method: "POST",
      body: JSON.stringify(agreement)
    }),
  qrStatus: (sessionId: string) => request<QrStatusResponse>(`/auth/qr/status/${sessionId}`),
  startDevice: (agreement: AgreementAcceptance) =>
    request<DeviceStartResponse>("/auth/device/start", {
      method: "POST",
      body: JSON.stringify(agreement)
    }),
  deviceStatus: (sessionId: string) =>
    request<QrStatusResponse>(`/auth/device/status/${sessionId}`),
  me: () => request<{ user: User }>("/me"),
  startSync: () => request<SyncStartResponse>("/sync/start", { method: "POST" }),
  syncStatus: (jobId: string) => request<SyncStatusResponse>(`/sync/status/${jobId}`),
  graphMe: (params: URLSearchParams) => request<GraphResponse>(`/graph/me?${params}`),
  graphUser: (userId: string, params: URLSearchParams) =>
    request<GraphResponse>(`/graph/users/${userId}?${params}`),
  friends: () => request<FriendsResponse>("/friends"),
  invite: () => request<InviteCreateResponse>("/friends/invite", { method: "POST" }),
  acceptInvite: (code: string) =>
    request<void>("/friends/accept", {
      method: "POST",
      body: JSON.stringify({ code })
    }),
  compare: (friendId: string) => request<CompareResponse>(`/compare/${friendId}`),
  playlistPreview: (payload: PlaylistBuildRequest) =>
    request<PlaylistPreviewResponse>("/playlists/preview", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  createPlaylist: (payload: PlaylistCreateRequest) =>
    request<PlaylistCreateResponse>("/playlists/create", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteFriend: (friendId: string) => request<void>(`/friends/${friendId}`, { method: "DELETE" }),
  deleteMe: () => request<void>("/me", { method: "DELETE" })
};
