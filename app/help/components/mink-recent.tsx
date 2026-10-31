"use client";

import { Plus, X } from "lucide-react";
import type { MinkStrings } from "./mink-strings";
import type { RecentChat } from "./recent-chats";

/** The visitor's recent Mink AI chats, kept in this browser only. */
export function MinkRecentList({
  chats,
  activeId,
  strings: t,
  onOpen,
  onDelete,
  onNewChat,
  showNewChat = true,
}: {
  chats: RecentChat[];
  activeId: string | null;
  strings: MinkStrings;
  onOpen: (chat: RecentChat) => void;
  onDelete: (chat: RecentChat) => void;
  onNewChat: () => void;
  showNewChat?: boolean;
}) {
  return (
    <div className="hc-assistant-recent">
      {showNewChat && (
        <button
          type="button"
          className="hc-assistant-newchat"
          onClick={onNewChat}
        >
          <Plus size={17} aria-hidden />
          <span>{t.newChat}</span>
        </button>
      )}
      <h3 className="hc-assistant-recent-label">{t.recent}</h3>
      {chats.length === 0 ? (
        <p className="hc-assistant-recent-empty">{t.noRecent}</p>
      ) : (
        <ul>
          {chats.map((chat) => (
            <li
              key={chat.id}
              className={chat.id === activeId ? "is-active" : undefined}
            >
              <button
                type="button"
                className="hc-assistant-recent-open"
                onClick={() => onOpen(chat)}
                aria-current={chat.id === activeId ? "true" : undefined}
              >
                {chat.title}
              </button>
              <button
                type="button"
                className="hc-assistant-recent-delete"
                onClick={() => onDelete(chat)}
                aria-label={`${t.deleteChat}: ${chat.title}`}
                title={t.deleteChat}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hc-assistant-recent-note">{t.savedHere}</p>
    </div>
  );
}
