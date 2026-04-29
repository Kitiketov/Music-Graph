import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { api } from "../api/client";
import type { Friend, InviteCreateResponse } from "../types/api";

type Props = {
  initialInviteCode?: string | null;
  onInviteAccepted?: () => void;
  overlayFriendIds: string[];
  loadingOverlayIds: string[];
  onToggleOverlayFriend: (friend: Friend) => void;
  onFriendRemoved: (friendId: string) => void;
};

export function FriendsPanel({
  initialInviteCode,
  onInviteAccepted,
  overlayFriendIds,
  loadingOverlayIds,
  onToggleOverlayFriend,
  onFriendRemoved
}: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [invite, setInvite] = useState<InviteCreateResponse | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [deletingFriendIds, setDeletingFriendIds] = useState<Set<string>>(new Set());

  const loadFriends = useCallback(async () => {
    const response = await api.friends();
    setFriends(response.friends);
  }, []);

  useEffect(() => {
    void loadFriends();
  }, [loadFriends]);

  useEffect(() => {
    if (!initialInviteCode) return;

    const code = initialInviteCode;
    let cancelled = false;

    async function acceptFromLink() {
      try {
        await api.acceptInvite(code);
        if (cancelled) return;

        setInviteCode("");
        setMessage("Друг добавлен по ссылке приглашения");
        onInviteAccepted?.();
        await loadFriends();
      } catch (error) {
        if (cancelled) return;

        setInviteCode(code);
        setMessage(error instanceof Error ? error.message : "Не удалось принять приглашение");
      }
    }

    void acceptFromLink();

    return () => {
      cancelled = true;
    };
  }, [initialInviteCode, loadFriends, onInviteAccepted]);

  async function createInvite() {
    const created = await api.invite();
    setInvite(created);
    setMessage("Ссылка приглашения создана");
  }

  async function copyInviteLink() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.invite_url);
      setMessage("Ссылка приглашения скопирована");
    } catch {
      setMessage("Не удалось скопировать ссылку");
    }
  }

  async function acceptInvite() {
    if (!inviteCode.trim()) return;
    await api.acceptInvite(inviteCode.trim());
    setInviteCode("");
    setMessage("Друг добавлен");
    await loadFriends();
  }

  async function deleteFriend(friend: Friend) {
    const friendId = friend.friend.id;
    const confirmed = window.confirm(
      `Удалить ${friend.friend.display_login} из друзей? Общий доступ к графам пропадет у вас обоих.`
    );
    if (!confirmed) return;

    setDeletingFriendIds((current) => new Set(current).add(friendId));
    try {
      await api.deleteFriend(friendId);
      onFriendRemoved(friendId);
      setMessage("Друг удален");
      await loadFriends();
    } finally {
      setDeletingFriendIds((current) => {
        const next = new Set(current);
        next.delete(friendId);
        return next;
      });
    }
  }

  return (
    <section className="side-panel">
      <div className="panel-heading">
        <Users size={18} />
        <h2>Друзья</h2>
      </div>

      <div className="friend-list">
        <div className="friend-row active">
          <span>Мой граф</span>
          <small>основа</small>
        </div>
        {friends.map((item) => {
          const isOverlayActive = overlayFriendIds.includes(item.friend.id);
          const isLoading = loadingOverlayIds.includes(item.friend.id);
          const isDeleting = deletingFriendIds.has(item.friend.id);
          return (
            <div className={isOverlayActive ? "friend-row overlay-active" : "friend-row"} key={item.id}>
              <span>{item.friend.display_login}</span>
              <span className="friend-row-actions">
                <button
                  className="friend-overlay-button"
                  disabled={isLoading || isDeleting}
                  onClick={() => onToggleOverlayFriend(item)}
                  title={
                    isOverlayActive
                      ? "Убрать друга с визуализации"
                      : "Добавить друга на граф и подсветить общих артистов"
                  }
                  type="button"
                >
                  {isLoading ? "..." : isOverlayActive ? <X size={15} /> : <Plus size={15} />}
                </button>
                <button
                  className="friend-overlay-button danger"
                  disabled={isDeleting}
                  onClick={() => void deleteFriend(item)}
                  title="Удалить из друзей"
                  type="button"
                >
                  {isDeleting ? "..." : <Trash2 size={14} />}
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <div className="invite-box">
        <button className="icon-button wide" onClick={createInvite}>
          <UserPlus size={17} />
          Создать приглашение
        </button>
        {invite && (
          <div className="invite-url">
            <Link2 size={15} />
            <span>{invite.invite_url}</span>
            <button className="secondary-action compact invite-copy-button" onClick={() => void copyInviteLink()} type="button">
              <Copy size={14} />
              Скопировать
            </button>
          </div>
        )}
      </div>

      <div className="accept-box">
        <input
          value={inviteCode}
          onChange={(event) => setInviteCode(event.target.value)}
          placeholder="Код приглашения"
        />
        <button className="icon-button" onClick={acceptInvite} aria-label="accept invite">
          <UserPlus size={17} />
        </button>
      </div>
      {message && <p className="muted small">{message}</p>}
    </section>
  );
}
