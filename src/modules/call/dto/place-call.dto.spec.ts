import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PlaceCallDto } from './place-call.dto';

const errorsFor = (body: unknown): string[] =>
  validateSync(plainToInstance(PlaceCallDto, body)).flatMap(e => Object.values(e.constraints ?? {}));

describe('PlaceCallDto chatId', () => {
  it('accepts a phone-keyed 1:1 id', () => {
    expect(errorsFor({ chatId: '919876543210@c.us' })).toEqual([]);
  });

  it('accepts a LID-keyed 1:1 id, which is what a chat list often holds', () => {
    // Rejecting these made the dashboard's own call button answer 400 for any chat WhatsApp
    // stores by LID; the page resolves one id to the other before dialling.
    expect(errorsFor({ chatId: '222823071121574@lid' })).toEqual([]);
  });

  it('rejects a group, which this route cannot place', () => {
    expect(errorsFor({ chatId: '12345-678@g.us' })).not.toEqual([]);
  });

  it('rejects a bare number with no server', () => {
    expect(errorsFor({ chatId: '919876543210' })).not.toEqual([]);
  });

  it('rejects an id that merely contains the server mid-string', () => {
    expect(errorsFor({ chatId: '9@c.us.evil' })).not.toEqual([]);
  });

  it('rejects a missing chatId', () => {
    expect(errorsFor({})).not.toEqual([]);
  });
});
