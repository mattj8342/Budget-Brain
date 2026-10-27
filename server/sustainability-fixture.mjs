import {analyzeSustainability} from './sustainability.mjs';
import {sustainabilitySchema} from './sustainability-service.mjs';
export const id=n=>String(n).padStart(8,'0')+'-1111-4111-8111-111111111111';
export const ids={budget:id(1),rent:id(2),food:id(3),quarter:id(4),save:id(5),work:id(6),card:id(7),annual:id(8),goal:id(9),bank:id(10),savings:id(11),hidden:id(12),internal:id(13)};
export function fixture(){
 const cat=(key,balance,goal_type,goal_target,extra={})=>({id:ids[key],name:key,category_group_id:'household',budgeted:balance,balance,activity:0,goal_under_funded:0,goal_type,goal_target,...extra});
 const categories=[cat('rent',1000000,'NEED',1000000,{goal_cadence:1}),cat('food',200000,'NEED',100000,{goal_cadence:2}),cat('quarter',300000,'NEED',300000,{goal_cadence:4}),cat('save',200000,'MF',200000),cat('annual',1200000,'NEED',1200000,{goal_cadence:13}),cat('goal',50000,'TBD',100000,{goal_target_date:'2026-11-15',goal_under_funded:50000}),cat('card',50000,null,null),cat('work',-50000,'MF',900000,{category_group_id:'work'}),cat('internal',0,null,null,{internal:true})];
 const historical=['2026-07-01','2026-08-01','2026-09-01'].map(month=>({month,categories:[{id:ids.rent,activity:-1000000},{id:ids.food,activity:-500000},{id:ids.work,activity:-200000},{id:ids.card,activity:-800000},{id:ids.internal,activity:9000000}]}));
 const snapshot={budget_id:ids.budget,as_of:'2026-10-26',month:'2026-10-01',captured_at:'2026-10-26T16:00:00Z',server_knowledge:8,ready_to_assign:100000,categories,category_catalog:categories,historical_months:historical,accounts:[{id:ids.bank,name:'Checking',on_budget:true,type:'checking',balance:5000000},{id:ids.savings,name:'Savings',on_budget:true,type:'savings',balance:1000000}],transactions:[],obligations:[],issues:[],future_assigned_categories:[]};
 const settings={allocation_policy:{schema_version:1,card_category_ids:[ids.card],excluded_category_ids:[],excluded_group_ids:['work'],card_floors:[{category_id:ids.card,floor_milliunits:50000}]}};
 const raw={horizon_end:'2026-12-31',history_months:3,income_coverage_confirmed:true,category_coverage_confirmed:true,debt_coverage_confirmed:true,spending_window_representative_confirmed:true,cash_flow_coverage_confirmed:true,income_streams:[{id:'pay',label:'Net pay',amount:1000,cadence:'biweekly',certainty:'reliable',next_date:'2026-11-06',account_id:ids.bank}]};
 const f={snapshot,settings,input:sustainabilitySchema.parse(raw)};
 f.run=()=>analyzeSustainability(f);return f;
}
