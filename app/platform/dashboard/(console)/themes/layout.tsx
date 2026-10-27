import "./studio/studio.css";

// The Themes section's layout (wave TS-2). Its only job is to load Theme
// Studio's own stylesheet once, for every Themes and Theme Studio screen
// (studio/studio.css: every class starts with `studio-`, tokens from
// app/dashboard/dashboard.css only). It adds no markup, so the console layout
// above it still draws the frame, the sidebar and the content column.
export default function ThemesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
