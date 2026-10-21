import { useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import type { DiffBase, DiffBasesResponse } from "@/hooks/useDiffBases";

export function DiffBaselinePicker({
  value,
  choices,
  onSelect,
}: {
  value: DiffBase;
  choices: DiffBasesResponse;
  onSelect: (base: DiffBase) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const select = (base: DiffBase) => {
    onSelect(base);
    setOpen(false);
    setSearch("");
  };
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-1 text-ui">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0"
            aria-label={`Compare against: ${value.label}`}
          >
            <span className="truncate">Compare against: {value.label}</span>
            <ChevronDownIcon className="size-4 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
          <Command>
            <CommandInput
              aria-label="Search branches or enter a revision"
              placeholder="Branch, commit, tag, or HEAD~3…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              {search.trim() && (
                <CommandGroup heading="Revision">
                  <CommandItem
                    value={`Use ${search.trim()}`}
                    onSelect={() => select({ ref: search.trim(), label: search.trim() })}
                  >
                    Use {search.trim()}
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Branches">
                {[{ ref: "HEAD", label: "HEAD" }, ...choices.branches].map((base) => (
                  <CommandItem key={base.ref} value={base.label} onSelect={() => select(base)}>
                    <span className="truncate">{base.label}</span>
                    {value.ref === base.ref && <CheckIcon className="ml-auto size-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Recent commits">
                {choices.commits.map(({ commit, subject }) => (
                  <CommandItem
                    key={commit}
                    value={`${commit} ${subject}`}
                    onSelect={() => select({ ref: commit, label: commit.slice(0, 8), commit })}
                  >
                    <span className="font-mono">{commit.slice(0, 8)}</span>
                    <span className="truncate">{subject}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <span className="ml-auto shrink-0 text-muted-foreground">Working tree</span>
    </div>
  );
}
