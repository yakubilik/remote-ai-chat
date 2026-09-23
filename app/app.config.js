// The public repo carries no account-scoped identifiers: bundle id, team,
// owner and EAS project id live in an uncommitted identity.local.json.
// See IDENTITY.local.md. Without that file this is plain app.json.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const local = path.join(__dirname, 'identity.local.json');
  if (!fs.existsSync(local)) return config;
  const id = JSON.parse(fs.readFileSync(local, 'utf8'));

  return {
    ...config,
    owner: id.owner ?? config.owner,
    ios: {
      ...config.ios,
      bundleIdentifier: id.bundleIdentifier ?? config.ios.bundleIdentifier,
      appleTeamId: id.appleTeamId ?? config.ios.appleTeamId,
    },
    extra: {
      ...config.extra,
      eas: { ...(config.extra && config.extra.eas), projectId: id.easProjectId },
    },
  };
};
