import { useEffect, useState } from "react";
import { Link2, UserPlus, Users } from "lucide-react";
import { api } from "../api/client";
import type { Friend, InviteCreateResponse } from "../types/api";

type Props = {
  selectedFriendId: string | null;
  onSelectFriend: (friendId: string | null) => void;
};

export function FriendsPanel({ selectedFriendId, onSelectFriend }: Props) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [invite, setInvite] = useState<InviteCreateResponse | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);

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

  return (
    <section className="side-panel">
      <div className="panel-heading">
        <Users size={18} />
        <h2>Друзья</h2>
      </div>

      <div className="friend-list">
        <button
          className={selectedFriendId === null ? "friend-row active" : "friend-row"}
          onClick={() => onSelectFriend(null)}
        >
          Мой граф
        </button>
        {friends.map((item) => (
          <button
            className={selectedFriendId === item.friend.id ? "friend-row active" : "friend-row"}
            key={item.id}
            onClick={() => onSelectFriend(item.friend.id)}
          >
            {item.friend.display_login}
          </button>
        ))}
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
