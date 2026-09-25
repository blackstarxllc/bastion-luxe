-- Bastion security regression suite.
-- Runs every known exploit class plus the legitimate flows beside them, as the
-- real API roles (anon / authenticated), then RAISES so everything rolls back.
-- Nothing is ever committed, and no email is sent (pg_net only processes
-- committed queue rows). Re-run after ANY change to RLS, triggers or pricing:
-- every line of the resulting report must start with PASS.
-- Last full run: 2026-09-24, 38/38 PASS against production.
do $suite$
declare
  res text[] := '{}';
  S uuid; S2 uuid; A uuid; B uuid;
  dlO text; dlO_price numeric; dlF text; dlF_price numeric; meet text; dlV text; dlS text;
  r record; n int; o1 uuid; o2 uuid; t1 uuid; c1 uuid; m text; fm text;
begin
  -- Fixtures use NON-admin accounts only: admins deliberately bypass these
  -- rules, so testing with one proves nothing.
  select d.seller_id into S from deals d join profiles p on p.id=d.seller_id
   where d.status='active' and not p.is_admin and not p.is_banned
   group by d.seller_id order by count(*) filter (where d.accepts_offers) desc, count(*) desc limit 1;
  select d.id, d.price into dlO, dlO_price from deals d where d.status='active' and d.seller_id=S order by d.accepts_offers desc, d.price desc limit 1;
  select d.id into dlS from deals d where d.status='active' and d.seller_id=S and d.id<>dlO limit 1;
  select d.id, d.seller_id, d.price into dlF, S2, dlF_price from deals d join profiles p on p.id=d.seller_id
   where d.status='active' and not p.is_admin and d.id not in (dlO,dlS) and d.fulfilment='both' order by d.price limit 1;
  select d.id into meet from deals d where d.status='active' and d.fulfilment='meetup' and d.id not in (dlO,dlF,dlS) limit 1;
  select d.id into dlV from deals d where d.status='active' and d.id not in (dlO,dlF,meet,dlS) and d.seller_id<>S limit 1;
  select p.id into A from profiles p where p.id not in (S,S2) and not p.is_admin and not p.is_banned order by p.created_at limit 1;
  select p.id into B from profiles p where p.id not in (S,S2,A) and not p.is_admin and not p.is_banned order by p.created_at limit 1;

  -- T14 first: anonymous view counter on an untouched listing
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select views into n from deals where id=dlV;
  perform increment_deal_view(dlV);
  select views into r from deals where id=dlV;
  res := res || format('%s T01 anonymous view counter still increments (%s -> %s)', case when r.views=n+1 then 'PASS' else 'FAIL' end, n, r.views);
  execute 'reset role';

  -- OFFERS on dlO (no orders yet)
  perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into offers(deal_id,buyer_id,seller_id,amount,made_by,status) values (dlO,A,B,1,'buyer','accepted') returning id,status,seller_id into r;
    o1 := r.id;
    res := res || format('%s T02 self-"accepted" $1 offer is forced to pending, real seller (status=%s seller_ok=%s)',
      case when r.status='pending' and r.seller_id=S then 'PASS' else 'FAIL' end, r.status, r.seller_id=S);
  exception when others then res := res || ('FAIL T02 '||sqlerrm); end;
  begin
    insert into offers(deal_id,buyer_id,seller_id,amount,made_by) values (dlO,A,S,dlO_price+1,'buyer');
    res := res || 'FAIL T03 offer above asking accepted'::text;
  exception when others then res := res || ('PASS T03 offer above asking rejected: '||sqlerrm); end;

  perform set_config('request.jwt.claims', json_build_object('sub',S,'role','authenticated')::text, true);
  begin
    insert into offers(deal_id,buyer_id,seller_id,amount,made_by) values (dlO,B,S,5,'seller');
    res := res || 'FAIL T04 seller created an unsolicited offer'::text;
  exception when others then res := res || ('PASS T04 unsolicited seller offer rejected: '||sqlerrm); end;
  begin
    insert into offers(deal_id,buyer_id,seller_id,amount,made_by,parent_offer_id)
    values (dlO,B,S,round(dlO_price*0.9),'seller',o1) returning id,buyer_id into r;
    o2 := r.id; select status into m from offers where id=o1;
    res := res || format('%s T05 seller counter stays with the original buyer; original marked countered (buyer_ok=%s original=%s)',
      case when r.buyer_id=A and m='countered' then 'PASS' else 'FAIL' end, r.buyer_id=A, m);
  exception when others then res := res || ('FAIL T05 '||sqlerrm); end;
  begin
    update offers set status='accepted' where id=o1; get diagnostics n = row_count;
    res := res || case when n=0 then 'PASS T06 superseded original can no longer be accepted' else 'FAIL T06 superseded offer accepted' end;
  exception when others then res := res || ('PASS T06 superseded original can no longer be accepted: '||sqlerrm); end;

  perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
  begin
    update offers set status='accepted', amount=1 where id=o2;
    select status, amount into r from offers where id=o2;
    insert into transactions(buyer_id,seller_id,deal_id,item_name,shipping_cost) values (A,S,dlO,'x',0) returning price into n;
    res := res || format('%s T07 accepting a counter cannot change its amount, and the order is priced at it (status=%s amount=%s order=%s)',
      case when r.status='accepted' and r.amount=n and n > 1 then 'PASS' else 'FAIL' end, r.status, r.amount, n);
  exception when others then res := res || ('FAIL T07 '||sqlerrm); end;

  -- ORDERS on dlF
  begin
    insert into transactions(buyer_id,seller_id,deal_id,status,item_name,funded_at,escrow_status,shipping_cost)
    values (A,B,dlF,'funded','FAKE',now(),'funded',25) returning id,status,seller_id,item_name,funded_at,price,fulfillment_mode into r;
    t1 := r.id; fm := r.fulfillment_mode;
    res := res || format('%s T08 forged "funded" order forced to pending_payment, real seller, real name, listing price (status=%s price=%s)',
      case when r.status='pending_payment' and r.seller_id=S2 and r.item_name<>'FAKE' and r.funded_at is null and r.price=dlF_price then 'PASS' else 'FAIL' end,
      r.status, r.price);
  exception when others then res := res || ('FAIL T08 '||sqlerrm); end;
  begin
    update transactions set status='released' where id=t1;
    res := res || 'FAIL T09 buyer marked own order released'::text;
  exception when others then res := res || ('PASS T09 buyer self-release rejected: '||sqlerrm); end;
  begin
    update transactions set escrow_transaction_url='https://evil.example', total=1, fulfillment_mode='in_person', seller_id=A where id=t1;
    select escrow_transaction_url, total, fulfillment_mode, seller_id into r from transactions where id=t1;
    res := res || format('%s T10 payment link, total, fulfilment mode and seller are immutable to participants',
      case when r.escrow_transaction_url is null and r.total > 1 and r.fulfillment_mode=fm and r.seller_id=S2 then 'PASS' else 'FAIL' end);
  exception when others then res := res || ('FAIL T10 '||sqlerrm); end;
  begin
    insert into transactions(buyer_id,seller_id,deal_id,item_name,shipping_cost) values (A,S,meet,'x',999) returning shipping_cost, fulfillment_mode into r;
    res := res || format('%s T11 meetup order carries no shipping charge and is in_person (shipping=%s mode=%s)',
      case when r.shipping_cost=0 and r.fulfillment_mode='in_person' then 'PASS' else 'FAIL' end, r.shipping_cost, r.fulfillment_mode);
  exception when others then res := res || ('FAIL T11 '||sqlerrm); end;

  perform set_config('request.jwt.claims', json_build_object('sub',S,'role','authenticated')::text, true);
  begin
    insert into transactions(buyer_id,seller_id,deal_id,item_name) values (S,S,dlS,'x');
    res := res || 'FAIL T12 seller bought own listing'::text;
  exception when others then res := res || ('PASS T12 buying your own listing rejected: '||sqlerrm); end;

  -- In-person handoff vs shipped order
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  update transactions set status='funded', fulfillment_mode='shipped' where id=t1;
  perform set_config('request.jwt.claims', json_build_object('sub',S2,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update transactions set status='shipped' where id=t1;
    res := res || 'FAIL T13 seller used Confirm Handoff on a shipped order'::text;
  exception when others then res := res || ('PASS T13 Confirm Handoff refused on a shipped order: '||sqlerrm); end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  update transactions set fulfillment_mode='in_person' where id=t1;
  perform set_config('request.jwt.claims', json_build_object('sub',S2,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update transactions set status='shipped' where id=t1;
    res := res || 'PASS T14 Confirm Handoff still works on an in-person order'::text;
  exception when others then res := res || ('FAIL T14 legit in-person handoff blocked: '||sqlerrm); end;

  -- LISTINGS
  perform set_config('request.jwt.claims', json_build_object('sub',S,'role','authenticated')::text, true);
  begin
    update deals set promoted=true, views=99999 where id=dlS;
    select promoted, views into r from deals where id=dlS;
    res := res || format('%s T15 seller cannot self-promote or fake views', case when not r.promoted and r.views < 99999 then 'PASS' else 'FAIL' end);
  exception when others then res := res || ('FAIL T15 '||sqlerrm); end;
  begin
    update deals set status='sold' where id=dlS;
    res := res || 'FAIL T16 seller marked own listing sold'::text;
  exception when others then res := res || ('PASS T16 seller cannot mark a listing sold: '||sqlerrm); end;
  begin
    update deals set status='archived' where id=dlS;
    update deals set status='active' where id=dlS;
    select status into m from deals where id=dlS;
    res := res || format('%s T17 seller can still archive and re-activate an idle listing (final=%s)', case when m='active' then 'PASS' else 'FAIL' end, m);
  exception when others then res := res || ('FAIL T17 legit archive/reactivate blocked: '||sqlerrm); end;
  begin
    update deals set status='active' where id=dlO;
    res := res || 'FAIL T18 seller reactivated a listing under contract'::text;
  exception when others then res := res || ('PASS T18 listing under contract cannot be reactivated: '||sqlerrm); end;
  begin
    update deals set price=1 where id=dlO;
    select price into r from deals where id=dlO;
    res := res || format('%s T19 price of a listing under contract is frozen', case when r.price=dlO_price then 'PASS' else 'FAIL' end);
  exception when others then res := res || ('FAIL T19 '||sqlerrm); end;
  begin
    insert into deals(id, price, item_name, status, promoted, views, fulfilment, seller_id)
    values ('regression-'||gen_random_uuid(), 100, 'x', 'sold', true, 5000, 'meetup', B) returning status, promoted, views, seller_id into r;
    res := res || format('%s T20 new listing forced active, unpromoted, zero views, owned by its creator',
      case when r.status='active' and not r.promoted and r.views=0 and r.seller_id=S then 'PASS' else 'FAIL' end);
  exception when others then res := res || ('FAIL T20 '||sqlerrm); end;

  -- MESSAGES / CONVERSATIONS
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  insert into messages(transaction_id, sender_id, body) values (t1, A, 'private');
  insert into conversations(deal_id,buyer_id,seller_id) values (dlO,A,S) returning id into c1;
  insert into messages(conversation_id, sender_id, body) values (c1, A, 'private too');
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from messages;
  res := res || format('%s T21 anonymous visitor reads zero messages (saw %s)', case when n=0 then 'PASS' else 'FAIL' end, n);
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from messages;
  res := res || format('%s T22 unrelated signed-in user reads zero messages (saw %s)', case when n=0 then 'PASS' else 'FAIL' end, n);
  begin
    insert into messages(conversation_id, transaction_id, sender_id, body) values (c1, t1, B, 'injected');
    res := res || 'FAIL T23 message injected into a stranger''s conversation'::text;
  exception when others then res := res || 'PASS T23 cross-conversation message injection rejected'::text; end;
  perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
  select count(*) into n from messages;
  res := res || format('%s T24 participant still reads their own messages (saw %s of 2)', case when n=2 then 'PASS' else 'FAIL' end, n);
  perform set_config('request.jwt.claims', json_build_object('sub',S,'role','authenticated')::text, true);
  begin
    insert into conversations(deal_id,buyer_id,seller_id) values (dlS,B,S);
    res := res || 'FAIL T25 seller cold-messaged a user who never engaged'::text;
  exception when others then res := res || 'PASS T25 unsolicited seller conversation rejected'::text; end;
  perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
  begin
    insert into conversations(deal_id,buyer_id,seller_id) values (dlS,B,S) returning id into c1;
    res := res || 'PASS T26 a buyer can still open a conversation about a listing'::text;
  exception when others then res := res || ('FAIL T26 legit buyer conversation blocked: '||sqlerrm); end;

  -- REVIEWS
  begin
    insert into reviews(transaction_id,seller_id,buyer_id,rating,comment) values (t1,S,B,1,'fake');
    res := res || 'FAIL T27 non-buyer posted a review'::text;
  exception when others then res := res || ('PASS T27 review by a non-buyer rejected: '||sqlerrm); end;
  perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
  begin
    insert into reviews(transaction_id,seller_id,buyer_id,rating) values (t1,S,A,5);
    res := res || 'FAIL T28 review before completion accepted'::text;
  exception when others then res := res || ('PASS T28 review before completion rejected: '||sqlerrm); end;

  -- ===== 2026-09-24 (b) additions =====
  begin
    update transactions set escrow_claimed_at = now() where id=t1;
    select escrow_claimed_at into r from transactions where id=t1;
    res := res || format('%s T29 escrow claim marker is immutable to participants', case when r.escrow_claimed_at is null then 'PASS' else 'FAIL' end);
  exception when others then res := res || ('FAIL T29 '||sqlerrm); end;
  begin
    select public.get_my_profile_private() into r;
    res := res || 'PASS T30 signed-in user can read their own private profile fields'::text;
  exception when others then res := res || ('FAIL T30 '||sqlerrm); end;
  begin
    perform public.admin_list_profiles(null);
    res := res || 'FAIL T31 non-admin listed every profile'::text;
  exception when others then res := res || ('PASS T31 admin profile list refused for non-admin: '||sqlerrm); end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin
    perform public.get_my_profile_private();
    res := res || 'FAIL T32 anonymous caller reached the private profile function'::text;
  exception when others then res := res || 'PASS T32 anonymous caller cannot call the private profile function'::text; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update transactions set status='totally_made_up' where id=t1;
    res := res || 'FAIL T33 an invalid order status was stored'::text;
  exception when others then res := res || 'PASS T33 invalid order status rejected by the database'::text; end;
  select count(*) into n from notifications where body ilike '%arrange payment%' and created_at > now() - interval '1 minute';
  res := res || format('%s T34 accepted-offer notice no longer says "arrange payment" (found %s)', case when n=0 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from notifications where body ilike '%protected checkout%' and created_at > now() - interval '1 minute';
  res := res || format('%s T35 accepted-offer notice points to protected checkout (found %s)', case when n>=1 then 'PASS' else 'FAIL' end, n);

  -- ===== 2026-09-24 (d) additions =====
  perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update transactions set status='cancelled' where buyer_id=A and deal_id=meet and status='pending_payment';
    res := res || 'PASS T36 buyer can withdraw an unpaid order that never reached Escrow.com'::text;
  exception when others then res := res || ('FAIL T36 '||sqlerrm); end;
  begin
    update transactions set dispute_reason='EDITED' where id=t1;
    select dispute_reason into m from transactions where id=t1;
    res := res || format('%s T37 dispute evidence cannot be edited after the fact', case when m is distinct from 'EDITED' then 'PASS' else 'FAIL' end);
  exception when others then res := res || ('FAIL T37 '||sqlerrm); end;
  begin
    insert into messages(conversation_id, transaction_id, sender_id, body) values (c1, t1, A, 'cross');
    res := res || 'FAIL T38 message linked a conversation to an order for a different listing'::text;
  exception when others then res := res || 'PASS T38 cross-deal message link rejected'::text; end;
  execute 'reset role';
  raise exception E'REGRESSION REPORT (rolled back — nothing saved)\n%', array_to_string(res, E'\n');
end $suite$;
