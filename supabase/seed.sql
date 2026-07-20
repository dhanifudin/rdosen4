-- Sample data for local testing. Replace the MAC address with the one your
-- own laptop/phone presents on the campus SSID (see ada/README.md for the
-- MAC-randomization caveat), then run the ada agent and watch this user's
-- presence flip to "present" on the board.

with u as (
  insert into public.users (full_name, identifier, role)
  values ('Test User', 'TEST-0001', 'student')
  returning id
)
insert into public.devices (user_id, mac_address, label)
select id, 'aa:bb:cc:dd:ee:ff', 'Test device (replace with your real MAC)'
from u;
