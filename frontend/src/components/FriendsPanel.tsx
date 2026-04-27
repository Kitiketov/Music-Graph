import { useEffect, useState } from "react";
import { Link2, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { api } from "../api/client";
import type { Friend, InviteCreateResponse } from "../types/api";

type Props = {
  overlayFriendIds: string[];
  loadingOverlayIds: string[];
  onToggleOverlayFriend: (friend: Friend) => void;
  onFriendRemoved: (friendId: string) => void;
};

export function FriendsPanel({
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

  async function loadFriends() {
    const response = await api.friends();
    setFriends(response.friends);
  }

  useEffect(() => {
    void loadFriends();
  }, []);

  async function createInvite() {
    const created = await api.invite();
    setInvite(created);
    setMessage("Ссылка приглашения создана");
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
