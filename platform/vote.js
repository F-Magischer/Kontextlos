// Plurality vote over option ids ("stay" = keep the current game).
// No votes: stay. Ties: the status quo wins, then the leader's choice, then a random pick.
function tally(options, votes, leaderVote, rand = Math.random) {
  const counts = Object.fromEntries(options.map((o) => [o, 0]));
  for (const v of votes.values()) if (Object.hasOwn(counts, v)) counts[v]++;
  const top = Math.max(0, ...Object.values(counts));
  if (!top) return { winner: options.includes("stay") ? "stay" : null, how: "none", counts };
  const tied = options.filter((o) => counts[o] === top);
  if (tied.length === 1) return { winner: tied[0], how: "votes", counts };
  if (tied.includes("stay")) return { winner: "stay", how: "tie-stay", counts };
  if (tied.includes(leaderVote)) return { winner: leaderVote, how: "leader", counts };
  return { winner: tied[Math.floor(rand() * tied.length)], how: "lot", counts };
}

module.exports = { tally };
