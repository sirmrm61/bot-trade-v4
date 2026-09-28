import { redirect } from "next/navigation";

/** Legacy path — the account page now lists every supported exchange. */
export default function NobitexPage() {
  redirect("/account");
}
