import { registerLead } from './actions';

export default function SignupPage() {
  return <main><h1>Sign up</h1><form action={registerLead}>
    <label htmlFor="email">Email</label>{' '}
    <input id="email" name="email" type="email" required />{' '}
    <button type="submit">Create example lead</button>
  </form></main>;
}
