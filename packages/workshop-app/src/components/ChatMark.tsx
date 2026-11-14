/**
 * The mark of a chat on its own, in no workspace: a cloud of a speech bubble (Figma node 762:426),
 * where a chat in a workspace has its folder (`WorkspaceIcon`), drawn as dark and as big.
 */
export const ChatMark = ({ small }: { small?: boolean }) => (
  // In the folder's box, drawn smaller: solid all over, it would otherwise look the heavier.
  <span aria-hidden="true" className={small ? 'grid h-[20.625px] w-[22px] shrink-0 place-items-center' : 'grid h-[30px] w-8 shrink-0 place-items-center'}>
  <svg width={small ? 19 : 26} height={small ? 19 : 26} viewBox="0 0 30 30" fill="none">
    <path
      d="M15.8741 2.10295C20.1614 1.43089 24.1987 4.03661 25.4965 8.05423C25.544 8.20104 25.6363 8.33089 25.7589 8.42459C27.4909 9.74682 28.7384 11.7214 29.1037 14.0508C29.8513 18.8199 27.8125 23.3042 23.0607 24.0493C22.4893 24.1389 21.9199 24.1698 21.361 24.1468C21.1097 24.1368 20.8548 24.2464 20.683 24.4441C19.4841 25.8241 16.6227 26.8051 14.6794 27.1097C12.0481 27.5222 9.51982 26.6032 7.76104 24.855C6.08295 25.4374 4.13696 25.5529 2.53655 25.5087C0.933445 25.4642 0.201056 23.8296 1.17005 22.5516C1.73264 21.8096 2.34026 20.9973 2.91503 20.1019C3.0732 19.8556 3.2745 19.629 3.50946 19.4262C2.45322 18.2812 1.70973 16.8204 1.44985 15.163C0.756691 10.7411 3.74951 6.58217 8.15694 5.89129C8.6345 5.81643 9.11044 5.78591 9.57917 5.79609C9.86514 5.8021 10.1363 5.66776 10.2967 5.45475C11.6044 3.71751 13.5607 2.4656 15.8741 2.10295Z"
      className="fill-kumo-contrast"
    />
  </svg>
  </span>
)
