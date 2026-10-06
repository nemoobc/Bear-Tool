// App — seluruh section view yang dulu inline di index.html (M2 migrasi React).
// Urutan WAJIB sama dengan urutan di index.html HEAD: DOM contract 205 test E2E.
import DashboardView from './views/dashboard.jsx';
import SendView from './views/send.jsx';
import SwapView from './views/swap.jsx';
import BridgeView from './views/bridge.jsx';
import DiscordView from './views/discord.jsx';
import DeployView from './views/deploy.jsx';
import ActivityView from './views/activity.jsx';
import NftView from './views/nft.jsx';
import DappsView from './views/dapps.jsx';
import SettingsView from './views/settings.jsx';

export default function App() {
  return (
    <>
      <DashboardView />
      <SendView />
      <SwapView />
      <BridgeView />
      <DiscordView />
      <DeployView />
      <ActivityView />
      <NftView />
      <DappsView />
      <SettingsView />
    </>
  );
}
