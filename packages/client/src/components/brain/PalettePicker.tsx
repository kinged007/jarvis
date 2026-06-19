import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import type { PalettePickerProps } from "./types";
import "./PalettePicker.css";

const PALETTES = [
  { id: 1, name: "Aurora" },
  { id: 2, name: "Ember" },
  { id: 3, name: "Obsidian" },
  { id: 4, name: "Frost" },
  { id: 5, name: "Verdant" },
  { id: 6, name: "Dusk" },
] as const;

export function PalettePicker({ current, onChange }: PalettePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, handleClickOutside, handleEscape]);

  const currentPalette = PALETTES.find((p) => p.id === current) ?? PALETTES[0];

  return (
    <div className="palette-picker" ref={containerRef}>
      <button
        className={`palette-picker__trigger ${open ? "palette-picker__trigger--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className={`palette-picker__swatch palette-picker__swatch--${currentPalette.id}`}
          aria-hidden="true"
        />
        {currentPalette.name}
        <ChevronDown />
      </button>
      {open && (
        <div className="palette-picker__menu" role="listbox">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === current}
              className={`palette-picker__option ${p.id === current ? "palette-picker__option--active" : ""}`}
              onClick={() => {
                onChange(p.id);
                setOpen(false);
              }}
            >
              <span
                className={`palette-picker__swatch palette-picker__swatch--${p.id}`}
                aria-hidden="true"
                style={{ width: 32, height: 18, borderRadius: 4 }}
              />
              <span className="palette-picker__option-name">{p.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
