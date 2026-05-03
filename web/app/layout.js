import "./styles.css";

export const metadata = {
  title: "Node Nexus Gateway",
  description: "Gateway console for decentralized local WebOps reports."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
