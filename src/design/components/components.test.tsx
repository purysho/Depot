import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tools } from "../../panels/registry";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { Input } from "./Input";
import { Sidebar } from "./Sidebar";
import { StatusBar, formatElapsed, statusTone } from "./StatusBar";
import { Tooltip, TooltipGroup } from "./Tooltip";

describe("Button", () => {
  it("defaults to type=button so it never submits a form by accident", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    render(
      <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
        <Button>Save</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not fire onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Run
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("marks the variant", () => {
    render(<Button variant="ghost">Cancel</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("data-variant", "ghost");
  });
});

describe("Badge", () => {
  it("always shows its label as text", () => {
    render(<Badge tone="error">Stopped</Badge>);
    expect(screen.getByText("Stopped")).toHaveAttribute("data-tone", "error");
  });
});

describe("Card", () => {
  it("has a hover border only when interactive", () => {
    const { container, rerender } = render(<Card>Static</Card>);
    expect(container.firstChild).not.toHaveClass("hover:border-text-link");
    rerender(<Card interactive>Clickable</Card>);
    expect(container.firstChild).toHaveClass("hover:border-text-link");
  });
});

describe("Input", () => {
  it("forwards its ref and attributes", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<Input ref={ref} aria-label="URL" aria-invalid="true" />);
    expect(ref.current).toBe(screen.getByRole("textbox", { name: "URL" }));
    expect(ref.current).toHaveAttribute("aria-invalid", "true");
  });
});

describe("EmptyState", () => {
  it("renders the heading, description and action", () => {
    render(
      <EmptyState icon={Inbox} title="No requests yet" description="Send one." action={<Button>New</Button>} />,
    );
    expect(screen.getByRole("heading", { name: "No requests yet" })).toBeInTheDocument();
    expect(screen.getByText("Send one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});

describe("Sidebar", () => {
  it("names every tool, in the plan's order, and marks the active one", () => {
    render(<Sidebar items={tools} activeId="relay" onSelect={() => undefined} />);
    const names = screen
      .getByRole("navigation", { name: "Tools" })
      .querySelectorAll("li button");
    expect(Array.from(names).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Switchyard",
      "Needle",
      "Relay",
      "Pulse",
      "BLACKBOX",
      "Forge",
    ]);
    expect(screen.getByRole("button", { name: "Relay" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Needle" })).not.toHaveAttribute("aria-current");
  });

  it("selects a tool on click", async () => {
    const onSelect = vi.fn();
    render(<Sidebar items={tools} activeId="switchyard" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Pulse" }));
    expect(onSelect).toHaveBeenCalledWith("pulse");
  });

  it("moves focus with the arrow keys, wrapping at the ends", async () => {
    render(<Sidebar items={tools} activeId="switchyard" onSelect={() => undefined} />);
    screen.getByRole("button", { name: "Switchyard" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: "Needle" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("button", { name: "Forge" })).toHaveFocus();
  });

  it("shows a settings button only when there is somewhere to go", () => {
    const { rerender } = render(<Sidebar items={tools} activeId="needle" onSelect={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    rerender(<Sidebar items={tools} activeId="needle" onSelect={() => undefined} onOpenSettings={() => undefined} />);
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("Tooltip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderTip = (describes = false) =>
    render(
      <TooltipGroup delay={700} skipDelay={300}>
        <Tooltip label="Open Needle" describes={describes}>
          <button type="button">A</button>
        </Tooltip>
        <Tooltip label="Open Relay">
          <button type="button">B</button>
        </Tooltip>
      </TooltipGroup>,
    );

  it("opens after the hover delay, not before", () => {
    renderTip();
    fireEvent.pointerEnter(screen.getByText("A").parentElement!, { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(699));
    expect(screen.queryByText("Open Needle")).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByText("Open Needle")).toBeInTheDocument();
  });

  it("opens at once on keyboard focus and closes on Escape", () => {
    renderTip();
    act(() => screen.getByText("A").focus());
    expect(screen.getByText("Open Needle")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Open Needle")).toBeNull();
  });

  it("does not open on the focus that follows a mouse press", () => {
    renderTip();
    const wrapper = screen.getByText("A").parentElement!;
    fireEvent.pointerDown(wrapper);
    act(() => screen.getByText("A").focus());
    expect(screen.queryByText("Open Needle")).toBeNull();
  });

  it("skips the delay when moving straight to the next tooltip", () => {
    renderTip();
    const a = screen.getByText("A").parentElement!;
    const b = screen.getByText("B").parentElement!;
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(700));
    fireEvent.pointerLeave(a);
    fireEvent.pointerEnter(b, { pointerType: "mouse" });
    expect(screen.getByText("Open Relay")).toBeInTheDocument();
  });

  it("is hidden from assistive tech by default, and linked when it describes", () => {
    renderTip(true);
    act(() => screen.getByText("A").focus());
    const tip = screen.getByRole("tooltip");
    expect(screen.getByText("A")).toHaveAttribute("aria-describedby", tip.id);

    act(() => screen.getByText("B").focus());
    expect(screen.getByText("Open Relay")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("B")).not.toHaveAttribute("aria-describedby");
  });
});

describe("StatusBar", () => {
  it("formats elapsed time with hours only when needed", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(723_000)).toBe("12:03");
    expect(formatElapsed(3_733_000)).toBe("1:02:13");
    expect(formatElapsed(-5)).toBe("0:00");
  });

  it("maps HTTP status classes to tones", () => {
    expect(statusTone(204)).toBe("text-success");
    expect(statusTone(301)).toBe("text-info");
    expect(statusTone(404)).toBe("text-warning");
    expect(statusTone(503)).toBe("text-error");
  });

  it("shows empty states in words", () => {
    render(<StatusBar workspaceName={null} sessionStartedAt={null} processCount={null} lastRequestStatus={null} />);
    expect(screen.getByText("No workspace")).toBeInTheDocument();
    expect(screen.getByText("No session")).toBeInTheDocument();
    expect(screen.getByText("Pulse idle")).toBeInTheDocument();
  });

  it("ticks the session clock and shows live counts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
    render(
      <StatusBar
        workspaceName="api"
        onWorkspaceClick={() => undefined}
        sessionStartedAt={Date.now() - 61_000}
        processCount={1}
        lastRequestStatus={500}
      />,
    );
    expect(screen.getByText("1:01")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText("1:02")).toBeInTheDocument();
    expect(screen.getByText("1 process")).toBeInTheDocument();
    expect(screen.getByText("500")).toHaveClass("text-error");
    expect(screen.getByRole("button", { name: "Workspace: api. Switch workspace" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("ExternalLink", () => {
  it("is a normal new-tab link outside the desktop shell", async () => {
    const { ExternalLink } = await import("./ExternalLink");
    render(<ExternalLink href="https://github.com/purysho/Needle">Needle</ExternalLink>);
    const link = screen.getByRole("link", { name: "Needle" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    // jsdom has no Tauri runtime, so the click must not be intercepted.
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
