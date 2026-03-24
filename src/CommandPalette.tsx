import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Command } from "lucide-react";

export type CommandPaletteCommand = {
  id: string;
  title: string;
  description: string;
  disabled?: boolean;
  icon?: ReactNode;
};

type CommandPaletteProps = {
  commands: CommandPaletteCommand[];
  onClose: () => void;
  onRunCommand: (commandId: string) => void;
};

function getFirstEnabledCommandId(
  commands: CommandPaletteCommand[],
): string | null {
  return commands.find((command) => !command.disabled)?.id ?? null;
}

function getWrappedCommandId(
  commands: CommandPaletteCommand[],
  activeCommandId: string | null,
  direction: 1 | -1,
): string | null {
  const enabledIndexes = commands.reduce<number[]>((indexes, command, index) => {
    if (!command.disabled) {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (enabledIndexes.length === 0) {
    return null;
  }

  const activeIndex = commands.findIndex(
    (command) => command.id === activeCommandId && !command.disabled,
  );

  if (activeIndex === -1) {
    const fallbackIndex =
      direction === 1 ? enabledIndexes[0] : enabledIndexes.at(-1);
    return fallbackIndex === undefined ? null : commands[fallbackIndex].id;
  }

  const enabledPosition = enabledIndexes.indexOf(activeIndex);
  const nextPosition =
    (enabledPosition + direction + enabledIndexes.length) %
    enabledIndexes.length;

  return commands[enabledIndexes[nextPosition]].id;
}

export function CommandPalette({
  commands,
  onClose,
  onRunCommand,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [requestedActiveCommandId, setRequestedActiveCommandId] = useState<
    string | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredCommands = commands.filter((command) => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return true;
    }

    return `${command.title} ${command.description}`
      .toLowerCase()
      .includes(normalizedQuery);
  });
  const activeCommandId = filteredCommands.some(
    (command) => command.id === requestedActiveCommandId && !command.disabled,
  )
    ? requestedActiveCommandId
    : getFirstEnabledCommandId(filteredCommands);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setRequestedActiveCommandId((currentActiveCommandId) =>
        getWrappedCommandId(
          filteredCommands,
          activeCommandId ?? currentActiveCommandId,
          e.key === "ArrowDown" ? 1 : -1,
        ),
      );
      return;
    }

    if (e.key !== "Enter") {
      return;
    }

    const commandId =
      activeCommandId ?? getFirstEnabledCommandId(filteredCommands);
    if (!commandId) {
      return;
    }

    e.preventDefault();
    onRunCommand(commandId);
  };

  return (
    <div className="overlay-shell" role="presentation" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="command-palette__search">
          <Command className="command-palette__search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="command-palette__input"
            placeholder="Type a command"
          />
        </div>
        <div className="command-palette__results">
          {filteredCommands.length > 0 ? (
            filteredCommands.map((command) => {
              const isActive = command.id === activeCommandId;

              return (
                <button
                  key={command.id}
                  type="button"
                  disabled={command.disabled}
                  className={`command-palette__item${isActive ? " command-palette__item--active" : ""}`}
                  onClick={() => onRunCommand(command.id)}
                  onMouseEnter={() => {
                    if (!command.disabled) {
                      setRequestedActiveCommandId(command.id);
                    }
                  }}
                >
                  {command.icon ? (
                    <div className="command-palette__item-icon">
                      {command.icon}
                    </div>
                  ) : null}
                  <div className="command-palette__item-copy">
                    <div className="command-palette__item-title">
                      {command.title}
                    </div>
                    <div className="command-palette__item-description">
                      {command.description}
                    </div>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="command-palette__empty">
              No commands match “{query}”.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
