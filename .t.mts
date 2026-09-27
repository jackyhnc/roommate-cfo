import { startTrip } from './src/shopping.ts'
startTrip({ item: 'soap', budget: 15, forHouse: 'Calvin, Eford, Ryan' },
  (x) => console.log('CHAT:', x),
  (r) => { console.log('DONE:', JSON.stringify(r)); process.exit(0) })
