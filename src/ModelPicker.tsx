// Model picker for the on-device engine.
//
// A native <select> would be less code, but the popup is drawn by the OS — system
// font, system highlight — and no CSS reaches it. The list also carries three
// fields per row (name, weight, what it costs you), which a native <option>
// flattens into one string. Hence the ARIA combobox pattern: same keyboard
// contract as a <select>, laid out in the app's own type.

import { useEffect, useId, useRef, useState } from "react";
import type { OnDeviceModel } from "./lib/summarizer";

interface ModelPickerProps {
  models: OnDeviceModel[];
  value: string;
  disabled?: boolean;
  onChange: (modelId: string) => void;
  formatWeight: (mb: number) => string;
  // Id of the visible "Model" caption — the trigger has no <label> to bind to.
  labelId: string;
}

export function ModelPicker({
  models,
  value,
  disabled,
  onChange,
  formatWeight,
  labelId,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    models.findIndex((model) => model.id === value)
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const selected = models[selectedIndex];

  // Pointerdown, not click: closing on mousedown keeps a click that lands
  // outside from also activating whatever it landed on mid-close.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Keep the keyboard-active row visible when arrowing past the popup's edge.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function openList() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function commit(index: number) {
    onChange(models[index].id);
    setOpen(false);
    // Focus never left the trigger, but say so explicitly: closing by mouse
    // must leave the keyboard where closing by Enter does.
    triggerRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (open) setActiveIndex((i) => Math.min(i + 1, models.length - 1));
        else openList();
        break;
      case "ArrowUp":
        event.preventDefault();
        if (open) setActiveIndex((i) => Math.max(i - 1, 0));
        else openList();
        break;
      case "Home":
        if (open) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case "End":
        if (open) {
          event.preventDefault();
          setActiveIndex(models.length - 1);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) commit(activeIndex);
        else openList();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        // Let focus leave, but don't leave a popup hanging over the page.
        if (open) setOpen(false);
        break;
    }
  }

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="picker__trigger"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="picker__value">
          <span className="picker__name">{selected.label}</span>
          <span className="picker__weight">{formatWeight(selected.vramMb)}</span>
          <span className="picker__note">{selected.note}</span>
        </span>
        <svg
          className="picker__chevron"
          width="10"
          height="6"
          viewBox="0 0 10 6"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <ul className="picker__list" id={listId} role="listbox" ref={listRef}>
          {models.map((model, index) => (
            <li
              key={model.id}
              id={optionId(index)}
              role="option"
              aria-selected={model.id === value}
              data-active={index === activeIndex}
              className="picker__option"
              // Mouse hover drives the same active row the arrow keys do, so the
              // two input modes can't disagree about what Enter would pick.
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="picker__name">{model.label}</span>
              <span className="picker__weight">{formatWeight(model.vramMb)}</span>
              <span className="picker__note">{model.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
