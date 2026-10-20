# Workshop backend

For private read/count/notification horizons, dirty-thread delivery and reset recovery, read
[the unread-state design](../../docs/user-unread-state.md). Its verification section lists the
focused Worker/API suites. Background metadata reads must check current membership and existing
observer admission; do not re-register observers or invoke external gatekeeper verifiers per message.
