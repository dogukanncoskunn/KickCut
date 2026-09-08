import { Setup } from "./Setup";

/*
 * Just the form.
 *
 * The queue used to be a rail down the right of this screen, which meant the
 * running download lived in two different places depending on which tab you
 * were on - a column here, a floating panel everywhere else. It is the docked
 * panel in the bottom-left corner on every screen now, including this one, so
 * there is one place to look for it and adding a job does not make a column
 * appear and shove the form sideways.
 */
export function Download() {
  return <Setup />;
}
