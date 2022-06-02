# Patience-Online-Backend
https://patienceonline.com/  website currently redirects to my new game nodge as I only own one AWS ec2 instance    

## The goal of the game is to be the first player to get rid of all your Malus cards.

The game is played in alternating turns. The starting player is randomly determined.
Your turn ends after you have moved a card onto your Discard pile.

The bottom row represents the player side and the top row the opponents side.
The fields on the bottom row, from left to right, are called: Malus, Reserve, Discard, Stock.
The top row is mirrored.

The 8 fields in the middle of your screen, which are empty at the start of the game, are called Foundation.
Here you can pile up cards of same suit with increasing value: (♥️Ace, ♥️2, ♥️3,......, ♥️10, ♥️Jack,...)

The 8 fields that surround the Foundation are called Tableau.
Here you can pile up cards of alternating color and decreasing value: (♠️Jack, ♦️10, ♠️9, ♥️8, ♣️7,.....)

You can move cards from Tableau onto your opponents Malus and Discard
if they have same value and different suit or same suit and a value of +1 or -1: (♦️5, ♦️4, ♦️3, ♦️4, ♠️4, ♥️4, ♥️5;......)

You can only move one card at a time.

You can make 5 Moves each turn.

Moves to Foundation and moves from Stock are excluded from this and free.

During the first turn you can not Move cards to your opponents side.


![image](https://user-images.githubusercontent.com/39095721/171749601-7af3e371-dcf4-47ce-be79-821fdf1561b5.png)

![image](https://user-images.githubusercontent.com/39095721/171749685-f3d2214c-9f28-42a7-a5f8-b98ad7788f79.png)

![image](https://user-images.githubusercontent.com/39095721/171749726-8f832463-db87-4aca-9db4-d57ec141b9fb.png)

![image](https://user-images.githubusercontent.com/39095721/171749772-4985615e-a8ff-4237-a989-a327226f9762.png)

